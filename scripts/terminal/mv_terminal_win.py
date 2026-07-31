#!/usr/bin/env python3
"""Windows terminal wrapper using ConPTY via pywinpty.

Design principle: this wrapper is a FAITHFUL transport. Input from xterm.js
is forwarded to ConPTY verbatim and output from ConPTY is forwarded back
verbatim — nothing is added, removed, or rewritten, so no terminal feature
is ever filtered out for any application. The single exception is the
plugin's private OSC channel ("\x1b]RESIZE;cols;rows"), which is consumed
here to resize the ConPTY and never reaches the child.
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

RESIZE_PREFIX = b'\x1b]RESIZE;'
_BEL = 0x07
_ESC = 0x1B
_C1_ST = 0x9C


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


class InputParser:
    """Incremental parser that recognizes only escape-sequence BOUNDARIES.

    Every byte is emitted verbatim — ("text", bytes) for ordinary input,
    ("esc", bytes) for a complete escape sequence (terminator included).
    The plugin's private OSC RESIZE channel is the sole exception and
    surfaces as ("resize", (cols, rows)) instead of being forwarded.

    Terminators follow ECMA-48: OSC ends at BEL or ST (ESC \\ or C1 0x9C),
    DCS/APC/PM/SOS end at ST, CSI ends at a final byte in 0x40-0x7E,
    charset designations are 3 bytes, other escapes are 2 bytes.

    An earlier version only accepted BEL for OSC and swallowed everything
    following an ST-terminated reply (xterm.js answers OSC color queries
    with ST), freezing all input for full-screen TUIs such as kimi until a
    BEL happened to arrive (the resize channel) and flushed the backlog.
    """

    def __init__(self):
        self.buf = bytearray()

    def feed(self, data):
        """Consume bytes, return a list of events in input order."""
        self.buf += data
        events = []
        text = bytearray()

        def flush_text():
            if text:
                events.append(("text", bytes(text)))
                text.clear()

        i = 0
        n = len(self.buf)
        while i < n:
            if self.buf[i] != _ESC:
                text.append(self.buf[i])
                i += 1
                continue
            if i + 1 >= n:
                break  # lone ESC — wait for the next byte
            second = self.buf[i + 1]
            if second == ord(']') or second in (ord('P'), ord('_'), ord('^'), ord('X')):
                # OSC / DCS / APC / PM / SOS: read until BEL or ST
                end = self._find_string_end(i + 2, n)
                if end is None:
                    break  # incomplete sequence — wait for more data
                seq = bytes(self.buf[i:end])
                i = end
                flush_text()
                resize = self._match_resize(seq)
                if resize is not None:
                    events.append(("resize", resize))
                else:
                    events.append(("esc", seq))
            elif second == ord('['):
                # CSI: read until the final byte (0x40-0x7E)
                j = i + 2
                while j < n and not (0x40 <= self.buf[j] <= 0x7E):
                    j += 1
                if j >= n:
                    break  # incomplete sequence
                flush_text()
                events.append(("esc", bytes(self.buf[i:j + 1])))
                i = j + 1
            elif second in (ord('('), ord(')'), ord('*'), ord('+')):
                # Charset designation: 3 bytes total
                if i + 2 >= n:
                    break
                flush_text()
                events.append(("esc", bytes(self.buf[i:i + 3])))
                i += 3
            else:
                # Two-byte escape (SS2/SS3, Alt+<key>, ...): forward verbatim
                flush_text()
                events.append(("esc", bytes(self.buf[i:i + 2])))
                i += 2

        del self.buf[:i]
        flush_text()
        return events

    def _find_string_end(self, start, n):
        """Return the index just past the terminator of a string sequence
        (OSC/DCS/APC/PM/SOS) whose payload starts at `start`, or None when
        the sequence is still incomplete. A stray ESC other than ST aborts
        the string per ECMA-48; the bytes before it are emitted as the
        aborted sequence so no byte is ever lost."""
        j = start
        while j < n:
            c = self.buf[j]
            if c == _BEL or c == _C1_ST:
                return j + 1
            if c == _ESC:
                if j + 1 >= n:
                    return None  # possible ST split across chunks
                if self.buf[j + 1] == ord('\\'):
                    return j + 2
                return j  # aborted string; the new ESC starts a fresh sequence
            j += 1
        return None

    def _match_resize(self, seq):
        """Parse \\x1b]RESIZE;cols;rows<BEL|ST> into (cols, rows), else None."""
        if not seq.startswith(RESIZE_PREFIX):
            return None
        body = seq[len(RESIZE_PREFIX):]
        if body.endswith(b'\x07') or body.endswith(bytes([_C1_ST])):
            body = body[:-1]
        elif body.endswith(b'\x1b\\'):
            body = body[:-2]
        try:
            cols, rows = body.decode('ascii').split(';')
            return (int(cols), int(rows))
        except (ValueError, UnicodeDecodeError):
            return None

    def flush(self):
        """EOF on stdin: emit every remaining byte so nothing is lost."""
        if not self.buf:
            return []
        rest = bytes(self.buf)
        self.buf.clear()
        return [("text", rest)]


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

        parser = InputParser()
        pending_text = bytearray()

        while running and pty.isalive():
            try:
                data = sys.stdin.buffer.read(1)
                if not data:
                    break
                for kind, payload in parser.feed(data):
                    if kind == "resize":
                        try:
                            pty.set_size(payload[0], payload[1])
                        except Exception:
                            pass
                    elif kind == "esc":
                        # Escape sequences from xterm are 7-bit ASCII; latin-1
                        # is a lossless byte->str mapping for the write() below.
                        pty.write(payload.decode('latin-1'))
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

        # stdin closed — flush any bytes still held by the parser
        for kind, payload in parser.flush():
            try:
                if kind == "esc":
                    pty.write(payload.decode('latin-1'))
                else:
                    pty.write(payload.decode('utf-8', errors='replace'))
            except Exception:
                pass

        running = False
        sys.exit(0)

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
