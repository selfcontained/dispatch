import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { StringDecoder } from "node:string_decoder";
import { ReceiveBuffer, DEFAULT_REPLY_BYTES } from "./receive-buffer.js";

/** Trim before truncating, even when whitespace or a UTF-8 character spans writes. */
export class CommandOutput {
  private readonly decoder = new StringDecoder("utf8");
  private readonly prefix: ReceiveBuffer;
  private seen = 0;
  private trimmedLength = 0;
  received = false;

  constructor(private readonly limit: number | null) {
    this.prefix = new ReceiveBuffer(Math.max(0, limit ?? DEFAULT_REPLY_BYTES));
  }

  write(chunk: Buffer) {
    this.received = true;
    return this.consume(this.decoder.write(chunk));
  }

  private consume(text: string) {
    if (!this.seen) text = text.trimStart();
    const nonTrailing = text.trimEnd();
    if (nonTrailing)
      this.trimmedLength = this.seen + Buffer.byteLength(nonTrailing);
    this.seen += Buffer.byteLength(text);
    const remaining = this.prefix.limit - this.prefix.size;
    if (remaining) this.prefix.append(Buffer.from(text).subarray(0, remaining));
    return this.limit !== null || this.trimmedLength <= this.prefix.limit;
  }

  finish() {
    if (!this.consume(this.decoder.end()))
      throw new RunnerCallError({
        code: "too_large",
        message: "Command output exceeds its byte limit",
      });
    const truncated = this.trimmedLength > this.prefix.size;
    const prefix = this.prefix.bytes().subarray(0, this.trimmedLength);
    return {
      text: truncated
        ? new TextDecoder().decode(prefix, { stream: true })
        : prefix.toString("utf8"),
      truncated,
    };
  }
}
