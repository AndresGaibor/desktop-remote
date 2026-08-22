import { MAX_IPC_FRAME_BYTES } from "./protocol";

export class JsonLineDecoder<T = unknown> {
  private remainder = Buffer.alloc(0);

  push(chunk: Buffer | string): T[] {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const decoded: T[] = [];
    let cursor = 0;

    while (cursor < input.length) {
      const newline = input.indexOf(0x0a, cursor);
      if (newline < 0) {
        this.append(input.subarray(cursor));
        break;
      }

      const segment = input.subarray(cursor, newline);
      try {
        this.append(segment);
        if (this.remainder.length > 0) decoded.push(this.parseCurrent());
        this.remainder = Buffer.alloc(0);
      } catch (error) {
        this.remainder = Buffer.alloc(0);
        throw error;
      }
      cursor = newline + 1;
    }

    return decoded;
  }

  end(): T[] {
    if (this.remainder.length === 0) return [];
    try {
      return [this.parseCurrent()];
    } finally {
      this.remainder = Buffer.alloc(0);
    }
  }

  private append(segment: Buffer): void {
    if (this.remainder.length + segment.length > MAX_IPC_FRAME_BYTES) {
      this.remainder = Buffer.alloc(0);
      throw new Error("IPC frame exceeds 512 KiB limit");
    }
    if (segment.length === 0) return;
    this.remainder = this.remainder.length === 0
      ? Buffer.from(segment)
      : Buffer.concat([this.remainder, segment], this.remainder.length + segment.length);
  }

  private parseCurrent(): T {
    try {
      return JSON.parse(this.remainder.toString("utf8")) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid IPC JSON frame: ${message}`);
    }
  }
}
