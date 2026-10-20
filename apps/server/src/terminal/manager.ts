import { createHash, randomUUID } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { execFileSync } from "node:child_process";
import type { WebSocket } from "ws";

export const REPLAY_BYTES = 256 * 1024;
export const DISCONNECT_GRACE_MS = 60_000;
const MAX_INPUT_BYTES = 16 * 1024;

export function terminalOwner(session: string): string {
  return createHash("sha256").update(session).digest("hex");
}

/** Start from a small allowlist: never inherit Dispatch/agent tokens or hooks. */
export function terminalEnvironment(
  source = process.env
): Record<string, string> {
  const env: Record<string, string> = {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
  ]) {
    if (source[key]) env[key] = source[key]!;
  }
  return env;
}

export type PtyProcess = {
  pid: number;
  terminal: {
    write(data: string): number;
    resize(cols: number, rows: number): void;
    close(): void;
  };
  exited: Promise<number>;
  kill(): void;
};
export type SpawnTerminal = (
  cwd: string,
  output: (data: Uint8Array) => void
) => PtyProcess;

export const spawnTerminal: SpawnTerminal = (cwd, output) => {
  if (
    typeof Bun === "undefined" ||
    typeof Bun.Terminal !== "function" ||
    process.platform === "win32"
  ) {
    throw new Error(
      "Human terminals require Bun 1.3.13 or newer on macOS or Linux."
    );
  }
  if (process.getuid?.() === 0)
    throw new Error(
      "Human terminals require Dispatch to run as an ordinary OS user."
    );
  const shell = userInfo().shell || "/bin/sh";
  const proc = Bun.spawn([shell, "-l"], {
    cwd,
    env: terminalEnvironment(),
    terminal: { cols: 80, rows: 24, data: (_terminal, data) => output(data) },
  });
  return {
    pid: proc.pid,
    terminal: proc.terminal!,
    exited: proc.exited,
    kill() {
      // Interactive shells give foreground/background jobs distinct process
      // groups. Capture descendants before hanging up the PTY or killing the
      // shell, so ordinary running jobs are cleaned up too.
      const descendants = new Set<number>([proc.pid]);
      try {
        const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], {
          encoding: "utf8",
          timeout: 2000,
          maxBuffer: 4 * 1024 * 1024,
        })
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/).map(Number));
        let changed = true;
        while (changed) {
          changed = false;
          for (const [pid, parent] of rows) {
            if (descendants.has(parent) && !descendants.has(pid)) {
              descendants.add(pid);
              changed = true;
            }
          }
        }
      } catch {
        /* PTY hangup and process-group cleanup still apply. */
      }
      try {
        proc.terminal?.close();
      } catch {
        /* already closed */
      }
      for (const pid of [...descendants].reverse()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
    },
  };
};

type TerminalSession = {
  id: string;
  owner: string;
  clientId: string;
  agentId: string;
  cwd: string;
  process: PtyProcess;
  replay: Buffer;
  socket?: WebSocket;
  expiry?: ReturnType<typeof setTimeout>;
};

export class HumanTerminalManager {
  private sessions = new Map<string, TerminalSession>();
  constructor(
    private spawn: SpawnTerminal = spawnTerminal,
    private graceMs = DISCONNECT_GRACE_MS
  ) {}

  open(owner: string, clientId: string, agentId: string, cwd: string) {
    const existing = [...this.sessions.values()].find(
      (s) =>
        s.owner === owner && s.clientId === clientId && s.agentId === agentId
    );
    if (existing) return this.describe(existing);
    if (
      this.sessions.size >= 16 ||
      [...this.sessions.values()].filter((s) => s.owner === owner).length >= 4
    ) {
      throw new Error(
        "Terminal limit reached. End an existing terminal first."
      );
    }
    const id = randomUUID();
    const session: TerminalSession = {
      id,
      owner,
      clientId,
      agentId,
      cwd,
      process: undefined as unknown as PtyProcess,
      replay: Buffer.alloc(0),
    };
    session.process = this.spawn(cwd, (data) => {
      const bytes = Buffer.from(data);
      session.replay = Buffer.concat([session.replay, bytes]).subarray(
        -REPLAY_BYTES
      );
      const socket = session.socket;
      if (socket?.readyState === 1) {
        if (socket.bufferedAmount > 1024 * 1024)
          socket.close(1013, "Terminal output overflow; reconnect to resume.");
        else socket.send(bytes);
      }
    });
    this.sessions.set(id, session);
    this.expire(session);
    void session.process.exited.then((code) => {
      if (this.sessions.get(id) !== session) return;
      session.socket?.send(JSON.stringify({ type: "exit", code }));
      this.end(id, owner);
    });
    return this.describe(session);
  }

  private describe(s: TerminalSession) {
    return {
      id: s.id,
      agentId: s.agentId,
      cwd: s.cwd,
      host: hostname(),
      user: userInfo().username,
    };
  }
  resume(id: string, owner: string, clientId: string, agentId: string) {
    const s = this.sessions.get(id);
    return s &&
      s.owner === owner &&
      s.clientId === clientId &&
      s.agentId === agentId
      ? this.describe(s)
      : null;
  }
  owns(id: string, owner: string) {
    return this.sessions.get(id)?.owner === owner;
  }
  private expire(s: TerminalSession) {
    clearTimeout(s.expiry);
    s.expiry = setTimeout(() => this.end(s.id, s.owner), this.graceMs);
    s.expiry.unref?.();
  }
  attach(id: string, owner: string, socket: WebSocket): boolean {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner) return false;
    s.socket?.close(4001, "Terminal attached in another connection.");
    clearTimeout(s.expiry);
    s.socket = socket;
    socket.send(JSON.stringify({ type: "connected" }));
    if (s.replay.length) socket.send(s.replay);
    let budget = 64 * 1024;
    let last = Date.now();
    socket.on("message", (data, binary) => {
      if (s.socket !== socket || this.sessions.get(id) !== s) return;
      const size = Array.isArray(data)
        ? data.reduce((n, chunk) => n + chunk.byteLength, 0)
        : data.byteLength;
      if (Date.now() - last >= 1000) {
        budget = 64 * 1024;
        last = Date.now();
      }
      budget -= size;
      if (binary || size > MAX_INPUT_BYTES || budget < 0) {
        socket.close(1008, "Terminal input limit exceeded.");
        return;
      }
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "input" && typeof message.data === "string") {
          const written = s.process.terminal.write(message.data);
          // Bun's write returns accepted bytes; don't silently lose keystrokes.
          if (written < Buffer.byteLength(message.data))
            socket.close(1013, "Terminal input buffer full.");
        } else if (
          message.type === "resize" &&
          Number.isInteger(message.cols) &&
          Number.isInteger(message.rows) &&
          message.cols >= 2 &&
          message.cols <= 500 &&
          message.rows >= 1 &&
          message.rows <= 200
        ) {
          s.process.terminal.resize(message.cols, message.rows);
        } else socket.close(1008, "Invalid terminal message.");
      } catch {
        socket.close(1008, "Invalid terminal message.");
      }
    });
    socket.on("close", () => {
      if (s.socket === socket) {
        s.socket = undefined;
        this.expire(s);
      }
    });
    socket.on("error", () => socket.close());
    return true;
  }

  end(id: string, owner: string): boolean {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner) return false;
    this.sessions.delete(id);
    clearTimeout(s.expiry);
    s.socket?.close(1000, "Terminal ended.");
    // Closing the PTY hangs up the foreground job. Signal the shell's process
    // group too, so non-interactive descendants cannot outlive an explicit end.
    try {
      s.process.kill();
    } catch {
      /* already exited */
    }
    try {
      s.process.terminal.close();
    } catch {
      /* already closed */
    }
    try {
      process.kill(-s.process.pid, "SIGKILL");
    } catch {
      /* exited or no group */
    }
    s.replay = Buffer.alloc(0);
    return true;
  }
  shutdown() {
    for (const s of this.sessions.values()) this.end(s.id, s.owner);
  }
}
