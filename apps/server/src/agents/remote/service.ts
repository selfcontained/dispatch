import { readFileSync, watchFile, unwatchFile } from "node:fs";
import { createServer, type TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";
import {
  hostChannel,
  wireFrames,
  type Command,
  type Frame,
  type Placement,
} from "./protocol.js";

type Config = {
  id: string;
  host: string;
  port: number;
  cert: string;
  key: string;
  ca: string;
  approval: string;
  workspaces: string[];
  mcpOrigin: string;
  repoTool?: boolean;
};

export class RunnerUnavailable extends Error {}
export class RunnerHostGone extends Error {}

export function configuredRunner() {
  const filename = process.env.DISPATCH_REMOTE_SERVICE_CONFIG;
  return filename
    ? new RemoteRunnerService(JSON.parse(readFileSync(filename, "utf8")))
    : undefined;
}

export class RemoteRunnerService {
  private peer?: {
    socket: TLSSocket;
    send: (frame: Frame) => void;
    workspaces: Set<string>;
  };
  private readonly sockets = new Set<TLSSocket>();
  private readonly channels = new Map<string, Duplex>();
  private readonly pending = new Map<
    string,
    (frame?: Extract<Frame, { type: "result" }>) => void
  >();
  private listener?: ReturnType<typeof createServer>;

  constructor(private readonly config: Config) {
    if (new URL(config.mcpOrigin).protocol !== "https:")
      throw new Error("Runner MCP origin must use HTTPS");
  }

  get origin() {
    return this.config.mcpOrigin.replace(/\/$/, "");
  }
  get repoTool() {
    return this.config.repoTool === true;
  }

  private approved(socket: TLSSocket) {
    try {
      return (
        socket.authorized &&
        socket.getPeerCertificate().fingerprint256 ===
          readFileSync(this.config.approval, "utf8").trim()
      );
    } catch {
      return false;
    }
  }

  async start() {
    const { host, port, ca, cert, key, approval } = this.config;
    const listener = createServer(
      {
        ca: readFileSync(ca),
        cert: readFileSync(cert),
        key: readFileSync(key),
        requestCert: true,
        rejectUnauthorized: true,
      },
      (socket) => this.accept(socket)
    );
    this.listener = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(port, host, resolve);
    });
    watchFile(approval, { interval: 500, persistent: false }, this.recheck);
  }

  private recheck = () => {
    for (const socket of this.sockets)
      if (!this.approved(socket)) socket.destroy();
  };

  private accept(socket: TLSSocket) {
    socket.on("error", () => socket.destroy());
    if (!this.approved(socket) || this.sockets.size) return socket.destroy();
    this.sockets.add(socket);
    const deadline = setTimeout(() => socket.destroy(), 5000);
    socket.on("close", () => {
      clearTimeout(deadline);
      this.sockets.delete(socket);
      this.peer = undefined;
      for (const settle of this.pending.values()) settle();
      for (const channel of this.channels.values()) channel.push(null);
    });
    const send = wireFrames(socket, (frame) => {
      if (!this.approved(socket)) return socket.destroy();
      if (!this.peer) {
        if (
          frame.type !== "ready" ||
          frame.version !== 1 ||
          !Array.isArray(frame.workspaces)
        )
          return socket.destroy();
        clearTimeout(deadline);
        this.peer = { socket, send, workspaces: new Set(frame.workspaces) };
        return;
      }
      if (frame.type === "result") this.pending.get(frame.id)?.(frame);
      else if (frame.type === "data")
        this.channels.get(frame.id)?.push(Buffer.from(frame.data, "base64"));
      else if (frame.type === "close") this.channels.get(frame.id)?.push(null);
      else socket.destroy();
    });
  }

  available(placement: Placement) {
    return (
      placement.runner === this.config.id &&
      this.config.workspaces.includes(placement.workspace) &&
      Boolean(
        this.peer?.workspaces.has(placement.workspace) &&
        this.approved(this.peer.socket)
      )
    );
  }

  async request(placement: Placement, command: Command, open = false) {
    const peer = this.peer;
    if (
      !peer ||
      !this.available(placement) ||
      command.workspace !== placement.workspace
    ) {
      throw new RunnerUnavailable(
        "The enrolled runner is disconnected or the workspace is unavailable."
      );
    }
    const id = crypto.randomUUID();
    const channel = open
      ? hostChannel(id, peer.send, () => this.channels.delete(id))
      : undefined;
    // The HostClient takes over error handling after the attach acknowledgement.
    channel?.on("error", () => {});
    if (channel) this.channels.set(id, channel);
    try {
      const value = await new Promise<boolean | string | undefined>(
        (resolve, reject) => {
          const finish = (frame?: Extract<Frame, { type: "result" }>) => {
            clearTimeout(timer);
            this.pending.delete(id);
            if (!frame)
              reject(
                new RunnerUnavailable(
                  "Runner acknowledgement was lost; execution is unknown."
                )
              );
            else if (frame.code === "host-gone")
              reject(new RunnerHostGone(frame.error));
            else if (frame.error) reject(new Error(frame.error));
            else resolve(frame.value);
          };
          const timer = setTimeout(() => finish(), 20_000);
          this.pending.set(id, finish);
          try {
            peer.send({ type: "request", id, command });
          } catch {
            finish();
          }
        }
      );
      return { value, channel };
    } catch (error) {
      channel?.destroy();
      throw error;
    }
  }

  close() {
    unwatchFile(this.config.approval, this.recheck);
    for (const socket of this.sockets) socket.destroy();
    this.listener?.close();
  }
}
