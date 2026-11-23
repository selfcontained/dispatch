import { createHash, randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import {
  isTerminalControl,
  MAX_TERMINAL_INPUT_BYTES,
  TERMINAL_REPLAY_BYTES,
  type TerminalInfo,
} from "@dispatch/runner-protocol";

export const REPLAY_BYTES = TERMINAL_REPLAY_BYTES;
export const DISCONNECT_GRACE_MS = 60_000;

export function terminalOwner(session: string): string {
  return createHash("sha256").update(session).digest("hex");
}

type TerminalProcess = TerminalInfo & {
  terminal: {
    write(data: string): number;
    resize(cols: number, rows: number): void;
    close(): void;
    detach?(): void;
    resume?(): void;
  };
  exited: Promise<number | null>;
  /**
   * Why it ended without an exit code. The panel drops its screen on close,
   * so only the socket's close reason is seen. At most 123 bytes.
   */
  endReason?(): string | undefined;
  kill(): void;
};

export type TerminalBackend = (
  output: (data: Uint8Array) => void,
  inputFull: () => void
) => Promise<TerminalProcess>;

type TerminalSession = {
  id: string;
  owner: string;
  clientId: string;
  agentId: string;
  process: TerminalProcess;
  replay: Buffer;
  socket?: WebSocket;
  expiry?: ReturnType<typeof setTimeout>;
};

export class HumanTerminalManager {
  private sessions = new Map<string, TerminalSession>();
  constructor(private graceMs = DISCONNECT_GRACE_MS) {}

  private pending = new Map<
    string,
    {
      owner: string;
      opened: Promise<ReturnType<HumanTerminalManager["describe"]>>;
    }
  >();

  private existing(owner: string, clientId: string, agentId: string) {
    return [...this.sessions.values()].find(
      (s) =>
        s.owner === owner && s.clientId === clientId && s.agentId === agentId
    );
  }

  private reserve(owner: string, clientId: string, agentId: string) {
    const active = [...this.sessions.values(), ...this.pending.values()];
    if (
      active.length >= 16 ||
      active.filter((s) => s.owner === owner).length >= 4
    )
      throw new Error(
        "Terminal limit reached. End an existing terminal first."
      );
    const session: TerminalSession = {
      id: randomUUID(),
      owner,
      clientId,
      agentId,
      process: undefined as unknown as TerminalProcess,
      replay: Buffer.alloc(0),
    };
    const output = (data: Uint8Array) => {
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
    };
    const inputFull = () =>
      session.socket?.close(1013, "Terminal input buffer full.");
    return { session, output, inputFull };
  }

  async open(
    owner: string,
    clientId: string,
    agentId: string,
    open: TerminalBackend
  ) {
    const existing = this.existing(owner, clientId, agentId);
    if (existing) return this.describe(existing);
    const key = JSON.stringify([owner, clientId, agentId]);
    const pending = this.pending.get(key);
    if (pending) return pending.opened;
    const { session, output, inputFull } = this.reserve(
      owner,
      clientId,
      agentId
    );
    const opened = open(output, inputFull)
      .then((process) => {
        if (this.pending.get(key)?.opened !== opened) {
          process.kill();
          throw new Error("Terminal was closed before it could open.");
        }
        return this.activate(session, process);
      })
      .finally(() => {
        if (this.pending.get(key)?.opened === opened) this.pending.delete(key);
      });
    this.pending.set(key, { owner, opened });
    return opened;
  }

  private activate(session: TerminalSession, process: TerminalProcess) {
    const { id, owner } = session;
    session.process = process;
    this.sessions.set(id, session);
    this.expire(session);
    void process.exited.then((code) => {
      if (this.sessions.get(id) !== session) return;
      if (code === null) {
        this.end(
          id,
          owner,
          process.endReason?.() ?? "Runner terminal connection ended."
        );
      } else {
        if (session.socket?.readyState === 1)
          session.socket.send(JSON.stringify({ type: "exit", code }));
        this.end(id, owner);
      }
    });
    return this.describe(session);
  }

  private describe(s: TerminalSession) {
    const { cwd, host, user } = s.process;
    return { id: s.id, agentId: s.agentId, cwd, host, user };
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
    try {
      s.process.terminal.resume?.();
    } catch {
      this.end(id, owner, "Runner terminal connection ended.");
      return true;
    }
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
      if (binary || size > MAX_TERMINAL_INPUT_BYTES || budget < 0) {
        socket.close(1008, "Terminal input limit exceeded.");
        return;
      }
      try {
        const message = JSON.parse(data.toString());
        if (!isTerminalControl(message)) {
          socket.close(1008, "Invalid terminal message.");
          return;
        }
        if (message.type === "input") {
          const written = s.process.terminal.write(message.data);
          // Bun's write returns accepted bytes; don't silently lose keystrokes.
          if (written < Buffer.byteLength(message.data))
            socket.close(1013, "Terminal input buffer full.");
        } else if (message.type === "resize") {
          s.process.terminal.resize(message.cols, message.rows);
        } else socket.close(1008, "Invalid terminal message.");
      } catch {
        socket.close(1008, "Invalid terminal message.");
      }
    });
    socket.on("close", () => {
      if (s.socket === socket) {
        s.socket = undefined;
        try {
          s.process.terminal.detach?.();
          this.expire(s);
        } catch {
          this.end(id, owner);
        }
      }
    });
    socket.on("error", () => socket.close());
    return true;
  }

  end(id: string, owner: string, reason = "Terminal ended."): boolean {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner) return false;
    this.sessions.delete(id);
    clearTimeout(s.expiry);
    const socket = s.socket;
    s.socket = undefined;
    socket?.close(1000, reason);
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
    s.replay = Buffer.alloc(0);
    return true;
  }
  shutdown() {
    this.pending.clear();
    for (const s of this.sessions.values()) this.end(s.id, s.owner);
  }
}
