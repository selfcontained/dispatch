/** Geometric growth bounds both backing bytes and bookkeeping for tiny writes. */
export class ReceiveBuffer {
  private storage = Buffer.alloc(0);
  size = 0;

  constructor(readonly limit: number) {}

  append(bytes: Buffer) {
    const end = this.size + bytes.length;
    if (end > this.limit) return false;
    if (end > this.storage.length) {
      const next = Buffer.allocUnsafe(
        Math.min(this.limit, Math.max(end, 256, this.storage.length * 2))
      );
      this.storage.copy(next, 0, 0, this.size);
      this.storage = next;
    }
    bytes.copy(this.storage, this.size);
    this.size = end;
    return true;
  }

  bytes() {
    return this.storage.subarray(0, this.size);
  }
}

export const DEFAULT_REPLY_BYTES = 32 * 1024 * 1024;
