type DataHandler = (data: string) => void;
type ExitHandler = (event: { exitCode: number; signal: string | null }) => void;

type BunTerminalRuntime = {
  Terminal: new (options: {
    cols?: number;
    rows?: number;
    name?: string;
    data?: (_terminal: unknown, data: Uint8Array) => void;
    exit?: (_terminal: unknown, code: number, signal?: string | null) => void;
  }) => {
    write(data: string | ArrayBufferView): number;
    resize(cols: number, rows: number): void;
    close(): void;
  };
  spawn(
    cmd: string[],
    options: {
      terminal: {
        write(data: string | ArrayBufferView): number;
        resize(cols: number, rows: number): void;
        close(): void;
      };
    }
  ): {
    exited: Promise<number>;
    kill(signal?: number | string): void;
  };
};

export interface BunPtyProcess {
  onData(cb: DataHandler): void;
  onExit(cb: ExitHandler): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface SpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
}

export function spawn(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {}
): BunPtyProcess {
  const bunRuntime = (globalThis as { Bun?: BunTerminalRuntime }).Bun;
  if (!bunRuntime) {
    throw new Error("bun-pty adapter requires the Bun runtime");
  }

  const decoder = new TextDecoder();
  const dataHandlers: DataHandler[] = [];
  const exitHandlers: ExitHandler[] = [];
  let exitFired = false;
  let decoderFlushed = false;
  let lastExitCode: number | null = null;
  let lastSignal: string | null = null;

  const emitData = (data: string): void => {
    if (!data) return;
    for (const handler of dataHandlers) {
      handler(data);
    }
  };

  const flushDecoder = (): void => {
    if (decoderFlushed) return;
    decoderFlushed = true;
    emitData(decoder.decode());
  };

  const fireExit = (): void => {
    if (exitFired) return;
    exitFired = true;
    flushDecoder();
    const event = {
      exitCode: lastExitCode ?? 0,
      signal: lastSignal,
    };
    for (const handler of exitHandlers) {
      handler(event);
    }
  };

  const terminal = new bunRuntime.Terminal({
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    name: opts.name ?? "xterm-256color",
    data: (_terminal, bytes) => {
      emitData(decoder.decode(bytes, { stream: true }));
    },
    exit: (_terminal, code, signal) => {
      if (lastExitCode === null) lastExitCode = code;
      if (lastSignal === null) lastSignal = signal ?? null;
      fireExit();
    },
  });

  const proc = bunRuntime.spawn([cmd, ...args], { terminal });
  void proc.exited.then((code) => {
    lastExitCode = code;
    setTimeout(() => fireExit(), 10);
  });

  return {
    onData(cb) {
      dataHandlers.push(cb);
    },
    onExit(cb) {
      exitHandlers.push(cb);
    },
    write(data) {
      terminal.write(data);
    },
    resize(cols, rows) {
      terminal.resize(cols, rows);
    },
    kill(signal) {
      try {
        proc.kill(signal);
      } catch {}
      try {
        terminal.close();
      } catch {}
    },
  };
}
