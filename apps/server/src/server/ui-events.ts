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
  private clients = new Set<NodeJS.WritableStream>();
  private nextId = 1;
  private eventsPublished = 0;
  private writeFailures = 0;

  subscribe(stream: NodeJS.WritableStream): () => void {
    this.clients.add(stream);
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

  /**
   * The periodic frame that proves the stream is still carrying data.
   *
   * The route already wrote an SSE comment on this interval, which keeps the
   * path warm but never reaches the client: a comment fires no `onmessage`,
   * so the browser cannot tell a live stream from one cut by a half-open
   * socket, and it sits `OPEN` delivering nothing. This is the same beat as a
   * real event, so the client can measure how long it has been since the last
   * one. Not through `publish`, which counts real UI traffic.
   */
  sendHeartbeat(stream: NodeJS.WritableStream): void {
    this.write({ type: "heartbeat" }, stream);
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
