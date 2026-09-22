import type { SharedUiEvent, StreamedAgentRecord } from "@dispatch/shared";
import type { ReleaseInfoSnapshot } from "../release-info.js";

import type { DiffStats } from "../shared/git/diff-stats.js";

/**
 * The four members whose payloads the web client models differently — see
 * `SharedUiEvent` in `@dispatch/shared` for why each one stays per side.
 * Every other member of the stream lives in that shared union.
 */
export type UiEvent =
  | { type: "snapshot"; agents: StreamedAgentRecord[] }
  | { type: "heartbeat" }
  | { type: "agent.upsert"; agent: StreamedAgentRecord }
  | {
      type: "agent.diff_state_changed";
      agentId: string;
      diffStats: DiffStats | null;
    }
  | {
      type: "release.cached_info_changed";
      snapshot: ReleaseInfoSnapshot | null;
    }
  | SharedUiEvent;

/** How every route and runtime module receives the broker's `publish`. */
export type PublishUiEvent = (event: UiEvent) => void;

export class UiEventBroker {
  /**
   * How often an idle stream is given something to carry.
   *
   * An SSE connection with no bytes on it is dropped by proxies, NAT and
   * anything else in the path, and neither end is told: the browser's
   * EventSource stays OPEN, so the client's own reconnect never fires and it
   * goes silently deaf. A quiet agent is exactly when that happens, and
   * exactly when someone then sends a message into a dead pipe.
   *
   * A real event rather than an SSE comment, because the client measures
   * staleness from the last frame it parsed and a comment never reaches it.
   */
  static readonly HEARTBEAT_MS = 15_000;

  private clients = new Set<NodeJS.WritableStream>();
  private nextId = 1;
  private eventsPublished = 0;
  private writeFailures = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  subscribe(stream: NodeJS.WritableStream): () => void {
    this.clients.add(stream);
    this.startHeartbeat();
    return () => {
      this.clients.delete(stream);
      if (this.clients.size === 0) this.stop();
    };
  }

  /** Stop the heartbeat. Idempotent; also called when the last client goes. */
  stop(): void {
    if (this.heartbeat === null) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== null) return;
    const timer = setInterval(() => {
      // Not through publish(): a beat every 15s would bury the published
      // count that exists to show how much real traffic the UI is getting.
      this.write({ type: "heartbeat" });
    }, UiEventBroker.HEARTBEAT_MS);
    timer.unref?.();
    this.heartbeat = timer;
  }

  hasConnectedClient(): boolean {
    return this.clients.size > 0;
  }

  publish(event: UiEvent): void {
    this.eventsPublished += 1;
    this.write(event);
  }

  getMetrics(): {
    clients: number;
    eventsPublished: number;
    writeFailures: number;
  } {
    return {
      clients: this.clients.size,
      eventsPublished: this.eventsPublished,
      writeFailures: this.writeFailures,
    };
  }

  sendSnapshot(
    stream: NodeJS.WritableStream,
    agents: StreamedAgentRecord[]
  ): void {
    this.write({ type: "snapshot", agents }, stream);
  }

  private write(event: UiEvent, target?: NodeJS.WritableStream): void {
    const payload = `id: ${this.nextId++}\ndata: ${JSON.stringify(event)}\n\n`;
    if (target) {
      target.write(payload);
      return;
    }

    for (const client of this.clients) {
      if ((client as { destroyed?: boolean }).destroyed) {
        this.clients.delete(client);
        continue;
      }

      try {
        client.write(payload);
      } catch {
        this.writeFailures += 1;
        this.clients.delete(client);
      }
    }
  }
}
