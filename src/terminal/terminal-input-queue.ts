// Bounded FIFO for terminal input frames written before the PTY is attached.
//
// Historically writeTerminalFrame dropped frames silently whenever `proc`
// was not ready — an agent calling runInTerminal right after openTerminal
// lost its command without any error while the login shell was still booting.
// The queue keeps program order: frames are flushed to the PTY pipe in the
// exact order they arrived once stdin exists.

const MAX_PENDING_BYTES = 256 * 1024;

export interface FrameSink {
  /** True when the sink can accept frames right now. */
  canWrite(): boolean;
  write(frame: Buffer): void;
}

export interface TerminalInputFrame {
  type: number;
  payload: string;
}

export class TerminalInputQueue {
  private frames: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes = MAX_PENDING_BYTES) {}

  /**
   * Deliver a frame: straight through when the sink is writable, otherwise
   * queued (oldest-first, bounded). Returns false when the frame had to be
   * dropped because the queue budget was exhausted.
   */
  enqueueOrWrite(type: number, payload: string, sink: FrameSink): boolean {
    return this.enqueueManyOrWrite([{ type, payload }], sink);
  }

  /** Queue all frames or none when the PTY is not writable. */
  enqueueManyOrWrite(inputs: TerminalInputFrame[], sink: FrameSink): boolean {
    const frames = inputs.map(({ type, payload }) => encodeFrame(type, payload));

    if (sink.canWrite()) {
      try {
        this.flush(sink);
        for (const frame of frames) sink.write(frame);
        return true;
      } catch {
        return false;
      }
    }
    const addedBytes = frames.reduce((sum, frame) => sum + frame.length, 0);
    if (this.bytes + addedBytes > this.maxBytes) return false;
    this.frames.push(...frames);
    this.bytes += addedBytes;
    return true;
  }

  /** Push every queued frame into the sink, preserving arrival order. */
  flush(sink: FrameSink): void {
    if (this.frames.length === 0 || !sink.canWrite()) return;
    while (this.frames.length > 0) {
      const frame = this.frames[0];
      sink.write(frame);
      this.frames.shift();
      this.bytes -= frame.length;
    }
  }

  clear(): void {
    this.frames = [];
    this.bytes = 0;
  }

  get pendingBytes(): number {
    return this.bytes;
  }
}

function encodeFrame(type: number, payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32LE(body.length, 1);
  return Buffer.concat([header, body]);
}
