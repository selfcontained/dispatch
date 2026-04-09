type StreamSession = {
  cdpSocket: WebSocket;
  viewers: Set<NodeJS.WritableStream>;
  status: "connecting" | "live" | "stopped";
  lastFrame: Buffer | null;
  refreshTimer: NodeJS.Timeout | null;
};

type OnStateChange = (agentId: string, event: "started" | "stopped") => void;
type OnStreamEnd = (agentId: string, lastFrame: Buffer, description: string | null) => void;

const MJPEG_BOUNDARY = "frame";
const FRAME_REFRESH_INTERVAL_MS = 1000;

export class StreamManager {
  private sessions = new Map<string, StreamSession>();
  private onStateChange: OnStateChange;
  private onStreamEnd?: OnStreamEnd;

  constructor(onStateChange: OnStateChange, onStreamEnd?: OnStreamEnd) {
    this.onStateChange = onStateChange;
    this.onStreamEnd = onStreamEnd;
  }

  async startStream(agentId: string, port: number): Promise<void> {
    if (this.sessions.has(agentId)) {
      throw new Error("Stream already active for this agent.");
    }

    // Discover CDP target URL
    const response = await fetch(`http://127.0.0.1:${port}/json`);
    if (!response.ok) {
      throw new Error(`Failed to discover CDP targets on port ${port}: ${response.status}`);
    }

    const targets = (await response.json()) as Array<{
      type: string;
      webSocketDebuggerUrl?: string;
    }>;
    const pageTarget = targets.find((t) => t.type === "page");
    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error("No page target found via CDP.");
    }

    const session: StreamSession = {
      cdpSocket: null as unknown as WebSocket,
      viewers: new Set(),
      status: "connecting",
      lastFrame: null,
      refreshTimer: null,
    };
    this.sessions.set(agentId, session);

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    session.cdpSocket = ws;

    let cdpId = 1;

    ws.addEventListener("open", () => {
      session.status = "live";
      ws.send(
        JSON.stringify({
          id: cdpId++,
          method: "Page.startScreencast",
          params: { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800 },
        })
      );
      // Re-push the last cached frame periodically so viewers that connect
      // between CDP frames still see content and the MJPEG connection stays alive.
      session.refreshTimer = setInterval(() => {
        if (session.lastFrame && session.viewers.size > 0) {
          this.writeFrameToViewers(session, session.lastFrame);
        }
      }, FRAME_REFRESH_INTERVAL_MS);
      this.onStateChange(agentId, "started");
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as {
          method?: string;
          params?: { data?: string; sessionId?: number };
        };

        if (msg.method === "Page.screencastFrame") {
          const frameData = msg.params?.data;
          const sessionId = msg.params?.sessionId;

          // Ack immediately to prevent Chrome throttling
          if (sessionId !== undefined) {
            ws.send(
              JSON.stringify({
                id: cdpId++,
                method: "Page.screencastFrameAck",
                params: { sessionId },
              })
            );
          }

          if (frameData) {
            const jpegBuffer = Buffer.from(frameData, "base64");
            session.lastFrame = jpegBuffer;
            this.pushFrame(agentId, jpegBuffer);
          }
        }
      } catch {
        // Ignore non-JSON or unexpected messages
      }
    });

    ws.addEventListener("close", () => {
      this.cleanupSession(agentId);
    });

    ws.addEventListener("error", () => {
      this.cleanupSession(agentId);
    });
  }

  stopStream(agentId: string, description?: string | null): void {
    const session = this.sessions.get(agentId);
    if (!session) {
      return;
    }

    session.status = "stopped";

    if (session.refreshTimer) {
      clearInterval(session.refreshTimer);
      session.refreshTimer = null;
    }

    try {
      if (session.cdpSocket.readyState === WebSocket.OPEN) {
        session.cdpSocket.send(
          JSON.stringify({ id: 999, method: "Page.stopScreencast" })
        );
        session.cdpSocket.close();
      }
    } catch {
      // Ignore close errors
    }

    for (const viewer of session.viewers) {
      try {
        viewer.end();
      } catch {
        // Ignore
      }
    }

    session.viewers.clear();

    if (session.lastFrame && this.onStreamEnd) {
      try {
        this.onStreamEnd(agentId, session.lastFrame, description ?? null);
      } catch {
        // Best-effort; don't block cleanup
      }
    }

    session.lastFrame = null;
    this.sessions.delete(agentId);
    this.onStateChange(agentId, "stopped");
  }

  addViewer(agentId: string, stream: NodeJS.WritableStream): () => void {
    const session = this.sessions.get(agentId);
    if (!session) {
      throw new Error("No active stream for this agent.");
    }

    session.viewers.add(stream);

    // Send the cached frame immediately so the viewer doesn't see a blank screen
    if (session.lastFrame) {
      this.writeFrameToViewers({ viewers: new Set([stream]) } as StreamSession, session.lastFrame);
    }

    return () => {
      session.viewers.delete(stream);
    };
  }

  hasStream(agentId: string): boolean {
    const session = this.sessions.get(agentId);
    return session !== undefined && session.status === "live";
  }

  stopAll(): void {
    for (const agentId of [...this.sessions.keys()]) {
      this.stopStream(agentId);
    }
  }

  private pushFrame(agentId: string, jpegBuffer: Buffer): void {
    const session = this.sessions.get(agentId);
    if (!session) {
      return;
    }
    this.writeFrameToViewers(session, jpegBuffer);
  }

  private writeFrameToViewers(session: StreamSession, jpegBuffer: Buffer): void {
    const header =
      `--${MJPEG_BOUNDARY}\r\n` +
      `Content-Type: image/jpeg\r\n` +
      `Content-Length: ${jpegBuffer.length}\r\n\r\n`;

    const frameChunk = Buffer.concat([
      Buffer.from(header),
      jpegBuffer,
      Buffer.from("\r\n"),
    ]);

    for (const viewer of session.viewers) {
      try {
        const v = viewer as NodeJS.WritableStream & { writable?: boolean; flush?: () => void };
        if (v.writable !== false) {
          v.write(frameChunk);
          if (typeof v.flush === "function") {
            v.flush();
          }
        }
      } catch {
        session.viewers.delete(viewer);
      }
    }
  }

  private cleanupSession(agentId: string): void {
    const session = this.sessions.get(agentId);
    if (!session || session.status === "stopped") {
      return;
    }
    this.stopStream(agentId);
  }
}
