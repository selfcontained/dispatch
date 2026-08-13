import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import type { AgentManager } from "../agents/manager.js";
import type { AgentRecord, AgentStatus } from "../agents/types.js";

const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
const PEER_RESCAN_INTERVAL_MS = 60_000;

type RemoteAgentShape = {
  id?: string;
  name?: string;
  status?: string;
};

type PeerRow = { id: string; url: string; outbound_token: string };

const AGENT_STATUSES: AgentStatus[] = [
  "creating",
  "running",
  "stopping",
  "stopped",
  "error",
  "archived",
] as AgentStatus[];

function asStatus(value: string | undefined): AgentStatus | undefined {
  return AGENT_STATUSES.includes(value as AgentStatus)
    ? (value as AgentStatus)
    : undefined;
}

/**
 * One long-lived SSE subscription per linked peer. Remote agent.upsert events
 * are mirrored onto this instance's shadow rows and rebroadcast on the local
 * bus, so the web UI needs zero changes. Status is state, not content: no
 * outbox, no replay — the snapshot each (re)connect pushes supersedes
 * anything missed while disconnected.
 */
export class PeerEventSubscriber {
  private controllers = new Map<string, AbortController>();
  private rescanTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly deps: {
      pool: Pool;
      agentManager: AgentManager;
      publishUiEvent: (event: { type: string; agent: unknown }) => void;
      withStreamFlag: <T extends AgentRecord>(
        agent: T
      ) => T & { hasStream: boolean };
      /** Called on each successful connect — the moment to drain the outbox. */
      onPeerReachable?: (peerId: string) => void;
      log: FastifyBaseLogger;
      fetchImpl?: typeof fetch;
    }
  ) {}

  start(): void {
    this.stopped = false;
    void this.rescan();
    this.rescanTimer = setInterval(
      () => void this.rescan(),
      PEER_RESCAN_INTERVAL_MS
    );
    this.rescanTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  /** Reconcile subscriptions with the current peer list. */
  private async rescan(): Promise<void> {
    if (this.stopped) return;
    let peers: PeerRow[];
    try {
      const result = await this.deps.pool.query<PeerRow>(
        `SELECT id, url, outbound_token FROM peers WHERE revoked_at IS NULL`
      );
      peers = result.rows;
    } catch (error) {
      this.deps.log.warn({ err: error }, "Peer rescan query failed");
      return;
    }
    const wanted = new Set(peers.map((p) => p.id));
    for (const [peerId, controller] of this.controllers) {
      if (!wanted.has(peerId)) {
        controller.abort();
        this.controllers.delete(peerId);
      }
    }
    for (const peer of peers) {
      if (!this.controllers.has(peer.id)) {
        const controller = new AbortController();
        this.controllers.set(peer.id, controller);
        void this.subscribeLoop(peer, controller.signal);
      }
    }
  }

  private async subscribeLoop(
    peer: PeerRow,
    signal: AbortSignal
  ): Promise<void> {
    let attempt = 0;
    while (!signal.aborted && !this.stopped) {
      try {
        const response = await (this.deps.fetchImpl ?? fetch)(
          `${peer.url}/api/v1/peers/events`,
          {
            headers: { authorization: `Bearer ${peer.outbound_token}` },
            signal,
          }
        );
        if (!response.ok || !response.body) {
          throw new Error(`Peer event stream responded ${response.status}.`);
        }
        attempt = 0;
        this.deps.onPeerReachable?.(peer.id);
        await this.consumeStream(peer.id, response.body, signal);
      } catch (error) {
        if (signal.aborted) return;
        this.deps.log.debug(
          { err: error, peerId: peer.id },
          "Peer event stream dropped; will reconnect"
        );
      }
      attempt += 1;
      const delay = Math.min(
        RECONNECT_BASE_MS * 2 ** Math.min(attempt, 6),
        RECONNECT_MAX_MS
      );
      await new Promise((resolve) => setTimeout(resolve, delay).unref?.());
    }
  }

  private async consumeStream(
    peerId: string,
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (data) await this.handleEvent(peerId, data);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async handleEvent(peerId: string, data: string): Promise<void> {
    let event: {
      type?: string;
      agent?: RemoteAgentShape;
      agents?: RemoteAgentShape[];
    };
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event.type === "agent.upsert" && event.agent?.id) {
      await this.mirrorRemoteAgent(peerId, event.agent);
    } else if (event.type === "snapshot" && Array.isArray(event.agents)) {
      for (const agent of event.agents) {
        if (agent?.id) await this.mirrorRemoteAgent(peerId, agent);
      }
    }
  }

  private async mirrorRemoteAgent(
    peerId: string,
    remote: RemoteAgentShape
  ): Promise<void> {
    try {
      const shadow = await this.deps.pool.query<{ id: string }>(
        `SELECT id FROM agents
          WHERE peer_id = $1 AND remote_id = $2 AND deleted_at IS NULL`,
        [peerId, remote.id]
      );
      const shadowId = shadow.rows[0]?.id;
      if (!shadowId) return;
      const updated = await this.deps.agentManager.updateShadowAgent(shadowId, {
        status: asStatus(remote.status),
        name: remote.name,
      });
      if (updated) {
        this.deps.publishUiEvent({
          type: "agent.upsert",
          agent: this.deps.withStreamFlag(updated),
        });
      }
    } catch (error) {
      this.deps.log.warn(
        { err: error, peerId, remoteId: remote.id },
        "Failed to mirror remote agent onto shadow row"
      );
    }
  }
}
