#!/usr/bin/env python3
"""PTY wrapper with resize support for Obsidian terminal plugin.

stdin speaks the same length-prefixed frame protocol as the Windows
wrapper (mv_terminal_win.py): [type: 1B][length: 4B LE][payload].
FRAME_INPUT is forwarded to the PTY verbatim; FRAME_RESIZE ("cols;rows")
resizes it. Explicit frame lengths keep every keystroke — a lone ESC
included — unambiguous, with no escape-sequence parsing at all.
"""
import os
import sys
import pty
import struct
import fcntl
import termios
import select
import signal
import time

FRAME_INPUT = 0
FRAME_RESIZE = 1
FRAME_HEADER_SIZE = 5


class FrameReader:
    """Reassemble length-prefixed stdin frames (see module docstring).

    Identical copy of the class in mv_terminal_win.py (the two wrappers are
    standalone single files); keep them in sync.
    """

    def __init__(self):
        self.buf = bytearray()

    def feed(self, data):
        """Consume bytes, return ("input", bytes) / ("resize", (cols, rows))."""
        self.buf += data
        events = []
        while len(self.buf) >= FRAME_HEADER_SIZE:
            frame_type = self.buf[0]
            length = int.from_bytes(self.buf[1:FRAME_HEADER_SIZE], "little")
            end = FRAME_HEADER_SIZE + length
            if len(self.buf) < end:
                break  # incomplete frame — wait for the rest of the payload
            payload = bytes(self.buf[FRAME_HEADER_SIZE:end])
            del self.buf[:end]
            if frame_type == FRAME_RESIZE:
                try:
                    cols, rows = payload.decode("ascii").split(";")
                    events.append(("resize", (int(cols), int(rows))))
                except (ValueError, UnicodeDecodeError):
                    pass  # malformed control frame — drop it, keep the stream alive
            else:
                events.append(("input", payload))
        return events

# Global to track child PID (also the process group ID) for signal handler
child_pid = None

def kill_process_group(pgid, sig):
    """Kill an entire process group."""
    try:
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError, OSError):
        pass

def cleanup_child(signum, frame):
    """Kill the entire process group when we receive a signal."""
    global child_pid
    if child_pid:
        # Kill entire process group (child is group leader)
        kill_process_group(child_pid, signal.SIGTERM)
        # Give processes a moment to exit gracefully
        for _ in range(10):
            try:
                pid, _ = os.waitpid(-child_pid, os.WNOHANG)
                if pid != 0:
                    break
            except ChildProcessError:
                break
            time.sleep(0.1)
        else:
            # Force kill the entire group if still running
            kill_process_group(child_pid, signal.SIGKILL)
    sys.exit(0)

def set_size(fd, cols, rows):
    """Set the PTY window size."""
    winsize = struct.pack('HHHH', rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)

def main():
    global child_pid

    # Parse args: terminal_pty.py [cols] [rows] [shell] [shell_args...]
    if len(sys.argv) < 4:
        print(f"Usage: {sys.argv[0]} cols rows shell [args...]", file=sys.stderr)
        sys.exit(1)

    cols = int(sys.argv[1])
    rows = int(sys.argv[2])
    shell = sys.argv[3]
    shell_args = sys.argv[3:]  # Include shell as argv[0]

    # On Linux, ask the kernel to send us SIGHUP if our parent dies.
    # Catches paths where the plugin's tab-close handler doesn't fire
    # and we'd otherwise be orphaned to init holding a live PTY tree.
    if sys.platform.startswith('linux'):
        try:
            import ctypes
            PR_SET_PDEATHSIG = 1
            libc = ctypes.CDLL('libc.so.6', use_errno=True)
            libc.prctl(PR_SET_PDEATHSIG, signal.SIGHUP, 0, 0, 0)
        except Exception:
            pass

    # Register signal handlers for cleanup BEFORE fork to avoid race condition
    signal.signal(signal.SIGTERM, cleanup_child)
    signal.signal(signal.SIGINT, cleanup_child)
    signal.signal(signal.SIGHUP, cleanup_child)

    pid, fd = pty.fork()
    child_pid = pid  # Store for signal handler

    if pid == 0:
        # Child process - already in its own process group via pty.fork()/setsid()
        os.execvp(shell, shell_args)
        sys.exit(1)

    # Parent process

    # Set initial size
    set_size(fd, cols, rows)

    stdin_fd = sys.stdin.fileno()

    # Make stdin non-blocking
    old_flags = fcntl.fcntl(stdin_fd, fcntl.F_GETFL)
    fcntl.fcntl(stdin_fd, fcntl.F_SETFL, old_flags | os.O_NONBLOCK)

    running = True
    reader = FrameReader()
    try:
        while running:
            try:
                rlist, _, _ = select.select([fd, stdin_fd], [], [], 0.05)
            except select.error:
                break

            for ready_fd in rlist:
                if ready_fd == fd:
                    try:
                        data = os.read(fd, 16384)
                        if not data:
                            running = False
                            break
                        os.write(sys.stdout.fileno(), data)
                        sys.stdout.flush()
                    except OSError:
                        running = False
                        break
                elif ready_fd == stdin_fd:
                    try:
                        data = os.read(stdin_fd, 16384)
                        if not data:
                            # stdin closed - plugin terminated
                            running = False
                            break
                        for kind, payload in reader.feed(data):
                            if kind == "resize":
                                set_size(fd, payload[0], payload[1])
                            else:
                                # Keyboard input — forwarded verbatim
                                os.write(fd, payload)
                    except OSError:
                        running = False
                        break

            # Check if child exited
            try:
                wpid, status = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    sys.exit(os.waitstatus_to_exitcode(status))
            except ChildProcessError:
                break
    finally:
        fcntl.fcntl(stdin_fd, fcntl.F_SETFL, old_flags)
        # Ensure entire process group is terminated when we exit
        if child_pid:
            kill_process_group(child_pid, signal.SIGTERM)
            for _ in range(10):
                try:
                    wpid, _ = os.waitpid(-child_pid, os.WNOHANG)
                    if wpid != 0:
                        break
                except ChildProcessError:
                    break
                time.sleep(0.1)
            else:
                kill_process_group(child_pid, signal.SIGKILL)

if __name__ == '__main__':
    main()
