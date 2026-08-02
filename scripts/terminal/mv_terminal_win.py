#!/usr/bin/env python3
"""Windows terminal wrapper using ConPTY via pywinpty.

Design principle: this wrapper is a FAITHFUL transport. Input from xterm.js
is forwarded to ConPTY verbatim and output from ConPTY is forwarded back
verbatim — nothing is added, removed, or rewritten, so no terminal feature
is ever filtered out for any application.

stdin speaks a length-prefixed frame protocol so message boundaries never
have to be guessed from the byte stream:

    [type: 1 byte][length: 4 bytes little-endian][payload]

    type 0 (FRAME_INPUT):  keyboard input, forwarded verbatim
    type 1 (FRAME_RESIZE): "cols;rows", applied to the ConPTY

The previous design multiplexed a private OSC resize channel onto the raw
input stream and parsed escape-sequence boundaries to recover it. In such a
stream a lone ESC byte (the Escape key) is indistinguishable from the start
of an escape sequence, so it was held back waiting for bytes that never
came — Escape (and the keystroke after it) never reached ConPTY. Explicit
frame lengths remove the ambiguity entirely; no parser, no timeouts.
"""
import sys
import threading
import os
import time

# pywinpty.PTY.read() is non-blocking on Windows and returns immediately when
# no data is available. Without a backoff the output reader thread spins at
# 100% CPU on one core whenever the terminal is idle. 10 ms keeps interactive
# latency imperceptible while dropping idle CPU to near zero.
IDLE_SLEEP_S = 0.01

FRAME_INPUT = 0
FRAME_RESIZE = 1
FRAME_HEADER_SIZE = 5


def read_utf8_char(buffer):
    """Read a complete UTF-8 character from buffer, handling multi-byte sequences."""
    if not buffer:
        return None, buffer

    first_byte = buffer[0]

    # Determine the number of bytes in this UTF-8 character
    if first_byte < 0x80:
        # ASCII (1 byte)
        return buffer[0:1], buffer[1:]
    elif first_byte < 0xC0:
        # Invalid start byte (continuation byte)
        return buffer[0:1], buffer[1:]
    elif first_byte < 0xE0:
        # 2-byte sequence
        needed = 2
    elif first_byte < 0xF0:
        # 3-byte sequence (CJK characters fall here)
        needed = 3
    elif first_byte < 0xF8:
        # 4-byte sequence
        needed = 4
    else:
        # Invalid byte
        return buffer[0:1], buffer[1:]

    if len(buffer) >= needed:
        return buffer[0:needed], buffer[needed:]
    else:
        # Not enough bytes yet, need more data
        return None, buffer


class FrameReader:
    """Reassemble length-prefixed stdin frames (see module docstring).

    feed() returns events in arrival order: ("input", bytes) for keyboard
    input and ("resize", (cols, rows)) for resize control frames. Split and
    coalesced frames are handled by buffering until a whole frame arrives —
    a deterministic wait, since the header states the exact payload length.
    Unknown frame types are treated as input so a newer frontend degrades
    gracefully instead of jamming.

    NOTE: mv_terminal_pty.py carries an identical copy of this class (the
    two wrappers are standalone single files); keep them in sync.
    """

    def __init__(self):
        self.buf = bytearray()

    def feed(self, data):
        """Consume bytes, return a list of events in input order."""
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


def main():
    # Parse args: terminal_win.py [cols] [rows] [shell]
    if len(sys.argv) < 4:
        print(f"Usage: {sys.argv[0]} cols rows shell", file=sys.stderr)
        sys.exit(1)

    cols = int(sys.argv[1])
    rows = int(sys.argv[2])
    shell = sys.argv[3]

    # pywinpty is required for Windows PTY support
    try:
        from winpty import PTY
    except ImportError:
        print(f"pywinpty not installed for this Python interpreter:", file=sys.stderr)
        print(f"  {sys.executable}", file=sys.stderr)
        print(f"", file=sys.stderr)
        print(f"Install it into THIS interpreter (not just any python on PATH):", file=sys.stderr)
        print(f'  "{sys.executable}" -m pip install pywinpty', file=sys.stderr)
        sys.exit(1)

    # Set stdin/stdout to binary mode (Windows-only module, imported here so
    # the parser above stays importable and testable on any platform)
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

    try:
        pty = PTY(cols, rows)
        pty.spawn(shell)

        running = True

        def read_output():
            nonlocal running
            while running and pty.isalive():
                try:
                    data = pty.read()
                    if not data:
                        time.sleep(IDLE_SLEEP_S)
                        continue
                    # pywinpty returns strings — forward output verbatim
                    output = data.encode('utf-8') if isinstance(data, str) else data
                    if output:
                        sys.stdout.buffer.write(output)
                        sys.stdout.buffer.flush()
                except Exception:
                    # Avoid a tight failure loop if something is persistently
                    # wrong; pty.isalive() will normally drop us out shortly.
                    time.sleep(IDLE_SLEEP_S)
            running = False

        output_thread = threading.Thread(target=read_output, daemon=True)
        output_thread.start()

        reader = FrameReader()
        pending_text = bytearray()
        stdin_fd = sys.stdin.fileno()

        while running and pty.isalive():
            try:
                # Blocks until at least one byte arrives; b"" means EOF.
                data = os.read(stdin_fd, 65536)
                if not data:
                    break
                for kind, payload in reader.feed(data):
                    if kind == "resize":
                        try:
                            pty.set_size(payload[0], payload[1])
                        except Exception:
                            pass
                    else:
                        pending_text.extend(payload)

                # pywinpty's write() takes str and encodes it as UTF-8, so
                # input bytes are re-assembled into complete UTF-8 characters
                # before writing (partials are held until they complete).
                while pending_text:
                    char_bytes, rest = read_utf8_char(bytes(pending_text))
                    if char_bytes is None:
                        break
                    pending_text = bytearray(rest)
                    try:
                        pty.write(char_bytes.decode('utf-8'))
                    except UnicodeDecodeError:
                        pty.write(char_bytes.decode('latin-1'))
            except Exception:
                break

        # stdin closed — flush any partial UTF-8 sequence still held
        if pending_text:
            try:
                pty.write(bytes(pending_text).decode('utf-8', errors='replace'))
            except Exception:
                pass

        running = False
        sys.exit(0)

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
