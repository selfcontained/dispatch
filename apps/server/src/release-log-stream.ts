export type ReleaseLogSink = {
  append(line: string): void;
  replace(line: string): void;
  rewind(count: number): void;
};

function isCsiFinalByte(char: string): boolean {
  return /^[\x40-\x7e]$/.test(char);
}

function parseCursorCount(raw: string): number {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export class ReleaseLogStreamProcessor {
  private readonly sink: ReleaseLogSink;
  private readonly onLine?: (line: string) => void;
  private currentLine = "";
  private escapeBuffer = "";
  private lastWasCR = false;
  private streamLineCount = 0;

  constructor(sink: ReleaseLogSink, onLine?: (line: string) => void) {
    this.sink = sink;
    this.onLine = onLine;
  }

  push(chunk: Buffer | string): void {
    const input = typeof chunk === "string" ? chunk : chunk.toString();
    for (const char of input) {
      if (this.escapeBuffer) {
        this.escapeBuffer += char;
        if (this.escapeBuffer.startsWith("\x1b[")) {
          if (this.escapeBuffer.length > 2 && isCsiFinalByte(char)) {
            this.handleCsi(this.escapeBuffer);
            this.escapeBuffer = "";
          }
          continue;
        }

        if (char === "\u0007" || this.escapeBuffer.endsWith("\x1b\\")) {
          this.escapeBuffer = "";
        }
        continue;
      }

      if (char === "\x1b") {
        this.escapeBuffer = char;
        continue;
      }

      if (char === "\r") {
        this.flushCarriageReturn();
        continue;
      }

      if (char === "\n") {
        this.flushNewline();
        continue;
      }

      this.currentLine += char;
    }
  }

  finish(): void {
    if (!this.currentLine) {
      return;
    }

    if (this.lastWasCR) {
      this.replaceLine(this.currentLine);
    } else {
      this.appendLine(this.currentLine);
    }
    this.currentLine = "";
    this.lastWasCR = false;
  }

  private handleCsi(sequence: string): void {
    const match = sequence.match(/^\x1b\[([0-9;?]*)([@-~])$/);
    if (!match) {
      return;
    }

    const [, rawParams, command] = match;
    const params = rawParams.replace(/^\?/, "").split(";").filter(Boolean);

    if (command === "A" || command === "F") {
      this.rewindLines(parseCursorCount(params[0] ?? ""));
      return;
    }

    if (command === "H" || command === "f") {
      this.rewindLines(this.streamLineCount);
      this.currentLine = "";
      this.lastWasCR = false;
    }
  }

  private flushCarriageReturn(): void {
    this.replaceLine(this.currentLine);
    this.currentLine = "";
    this.lastWasCR = true;
  }

  private flushNewline(): void {
    if (this.lastWasCR) {
      this.replaceLine(this.currentLine);
    } else {
      this.appendLine(this.currentLine);
    }
    this.currentLine = "";
    this.lastWasCR = false;
  }

  private appendLine(line: string): void {
    this.sink.append(line);
    this.streamLineCount += 1;
    this.onLine?.(line);
  }

  private replaceLine(line: string): void {
    this.sink.replace(line);
    if (this.streamLineCount === 0) {
      this.streamLineCount = 1;
    }
    this.onLine?.(line);
  }

  private rewindLines(count: number): void {
    const actual = Math.min(count, this.streamLineCount);
    if (actual <= 0) {
      return;
    }
    this.sink.rewind(actual);
    this.streamLineCount -= actual;
  }
}
