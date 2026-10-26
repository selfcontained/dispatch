import { channel } from "node:diagnostics_channel";
import type { Socket } from "node:net";

// These payloads are verified against Node 22's embedded Undici diagnostics.
// Keep this observer test-only: subscriptions add small synchronous overhead.
type Request = { origin: string; method: string; path: string };
type Payload = {
  request?: Request;
  socket?: Socket;
  connectParams?: {
    protocol?: string;
    hostname?: string;
    port?: string | number;
  };
  error?: unknown;
  response?: { statusCode?: number };
};
type RecordEntry = Record<string, unknown>;
type SocketEntry = {
  id: number;
  firstObservedAt: string;
  connectedAt?: string;
  localAddress?: string;
  localPort?: number;
  remoteAddress?: string;
  remotePort?: number;
};

function errorDetails(error: unknown, depth = 0): unknown {
  if (!error || typeof error !== "object") return String(error);
  if (depth >= 5) return "[cause depth limit]";
  const source = error as Record<string, unknown>;
  return Object.fromEntries(
    ["name", "message", "stack", "code", "errno", "syscall", "cause"]
      .filter((key) => source[key] !== undefined)
      .map((key) => [
        key,
        key === "cause" ? errorDetails(source[key], depth + 1) : source[key],
      ])
  );
}

export class RestartSocketTrace {
  private readonly records: RecordEntry[] = [];
  private cursor = 0;
  private dropped = 0;
  private observerErrors = 0;
  private readonly capacity = 4096;
  private readonly requestIds = new WeakMap<Request, number>();
  private readonly requestSockets = new WeakMap<Request, number>();
  private readonly sockets = new WeakMap<Socket, SocketEntry>();
  private nextRequestId = 1;
  private nextSocketId = 1;
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly origin: string) {
    const target = new URL(origin);
    const connectionMatches = (payload: Payload): boolean =>
      payload.connectParams?.protocol === target.protocol &&
      payload.connectParams.hostname === target.hostname &&
      String(payload.connectParams.port) === target.port;
    const requestMatches = (
      payload: Payload
    ): payload is Payload & { request: Request } =>
      !!payload.request && String(payload.request.origin) === origin;

    for (const event of [
      "beforeConnect",
      "connected",
      "connectError",
    ] as const) {
      this.subscribe(`undici:client:${event}`, (payload) => {
        if (!connectionMatches(payload)) return;
        this.record({
          event,
          origin,
          ...(payload.socket
            ? this.socketState(payload.socket, event === "connected")
            : {}),
          ...(payload.error ? { error: errorDetails(payload.error) } : {}),
        });
      });
    }
    for (const event of ["create", "error", "headers"] as const) {
      this.subscribe(`undici:request:${event}`, (payload) => {
        if (!requestMatches(payload)) return;
        this.record({
          event: `request:${event}`,
          ...this.requestState(payload.request),
          ...(payload.error ? { error: errorDetails(payload.error) } : {}),
          ...(payload.response
            ? { statusCode: payload.response.statusCode }
            : {}),
        });
      });
    }
    this.subscribe("undici:client:sendHeaders", (payload) => {
      if (!requestMatches(payload) || !payload.socket) return;
      const socket = this.socketState(payload.socket);
      this.requestSockets.set(payload.request, socket.socketId as number);
      this.record({
        event: "sendHeaders",
        ...this.requestState(payload.request),
        ...socket,
      });
    });
  }

  private guard(observe: () => void): void {
    // diagnostics_channel subscriber exceptions must never affect the request.
    try {
      observe();
    } catch {
      this.observerErrors++;
    }
  }

  private subscribe(name: string, observe: (payload: Payload) => void): void {
    const diagnostic = channel(name);
    const listener = (payload: unknown): void =>
      this.guard(() => observe(payload as Payload));
    diagnostic.subscribe(listener);
    this.cleanup.push(() => diagnostic.unsubscribe(listener));
  }

  private requestState(request: Request): RecordEntry {
    let id = this.requestIds.get(request);
    if (id === undefined) {
      id = this.nextRequestId++;
      this.requestIds.set(request, id);
    }
    return {
      requestId: id,
      socketId: this.requestSockets.get(request) ?? null,
      method: request.method,
      path: request.path,
      origin: String(request.origin),
    };
  }

  private socketState(socket: Socket, connected = false): RecordEntry {
    let entry = this.sockets.get(socket);
    if (!entry) {
      entry = {
        id: this.nextSocketId++,
        firstObservedAt: new Date().toISOString(),
        ...(connected ? { connectedAt: new Date().toISOString() } : {}),
        localAddress: socket.localAddress,
        localPort: socket.localPort,
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
      };
      this.sockets.set(socket, entry);
      // Undici already owns error handling. Add observers only; do not alter
      // its listeners, read the stream, destroy sockets, or change pool policy.
      const onError = (error: Error): void =>
        this.guard(() =>
          this.record({
            event: "socket:error",
            ...this.socketState(socket),
            error: errorDetails(error),
          })
        );
      const onEnd = (): void =>
        this.guard(() =>
          this.record({ event: "socket:end", ...this.socketState(socket) })
        );
      const onClose = (hadError: boolean): void =>
        this.guard(() =>
          this.record({
            event: "socket:close",
            ...this.socketState(socket),
            hadError,
          })
        );
      socket.once("error", onError);
      socket.once("end", onEnd);
      socket.once("close", onClose);
      this.cleanup.push(() => {
        socket.removeListener("error", onError);
        socket.removeListener("end", onEnd);
        socket.removeListener("close", onClose);
      });
    }
    if (connected && !entry.connectedAt)
      entry.connectedAt = new Date().toISOString();
    return {
      socketId: entry.id,
      firstObservedAt: entry.firstObservedAt,
      connectionObserved: entry.connectedAt !== undefined,
      connectedAt: entry.connectedAt,
      localAddress: entry.localAddress,
      localPort: entry.localPort,
      remoteAddress: entry.remoteAddress,
      remotePort: entry.remotePort,
      destroyed: socket.destroyed,
      readableEnded: socket.readableEnded,
      writableEnded: socket.writableEnded,
      bytesRead: socket.bytesRead,
      bytesWritten: socket.bytesWritten,
    };
  }

  private record(record: RecordEntry): void {
    const entry = {
      at: new Date().toISOString(),
      monotonicNs: process.hrtime.bigint().toString(),
      ...record,
    };
    if (this.records.length < this.capacity) this.records.push(entry);
    else {
      this.records[this.cursor] = entry;
      this.cursor = (this.cursor + 1) % this.capacity;
      this.dropped++;
    }
  }

  snapshot(): RecordEntry {
    return {
      origin: this.origin,
      capacity: this.capacity,
      dropped: this.dropped,
      observerErrors: this.observerErrors,
      records: [
        ...this.records.slice(this.cursor),
        ...this.records.slice(0, this.cursor),
      ],
    };
  }

  dispose(): void {
    for (const cleanup of this.cleanup.splice(0)) this.guard(cleanup);
  }
}
