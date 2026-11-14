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
  /** Each connected stream and the app session (tab) that opened it, if it said. */
  private clients = new Map<NodeJS.WritableStream, string | null>();
  private nextId = 1;
  private eventsPublished = 0;
  private writeFailures = 0;

  subscribe(
    stream: NodeJS.WritableStream,
    sessionId: string | null = null
  ): () => void {
    this.clients.set(stream, sessionId);
    return () => {
      this.clients.delete(stream);
    };
  }

  hasConnectedClient(): boolean {
    return this.clients.size > 0;
  }

  publish(event: UiEvent): void {
    this.eventsPublished += 1;
    this.write(event);
  }

  /** Send an event only to the streams opened by these app sessions. */
  publishToSessions(event: UiEvent, sessionIds: Iterable<string>): void {
    const targets = new Set(sessionIds);
    if (targets.size === 0) return;
    this.eventsPublished += 1;
    this.write(
      event,
      undefined,
      (sessionId) => sessionId !== null && targets.has(sessionId)
    );
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

  private write(
    event: UiEvent,
    target?: NodeJS.WritableStream,
    include?: (sessionId: string | null) => boolean
  ): void {
    const payload = `id: ${this.nextId++}\ndata: ${JSON.stringify(event)}\n\n`;
    if (target) {
      target.write(payload);
      return;
    }

    for (const [client, sessionId] of this.clients) {
      if (include && !include(sessionId)) continue;
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
