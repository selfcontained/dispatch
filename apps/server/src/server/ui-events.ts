import type { AgentRecord } from "../agents/manager.js";
import type { ReleaseInfoSnapshot } from "../release-info.js";

import type { DiffStats } from "../shared/git/diff-stats.js";
import type { TerminalUiState } from "../terminal/copy-mode-observer.js";

export type UiEvent =
  | { type: "snapshot"; agents: AgentRecord[] }
  | { type: "agent.upsert"; agent: AgentRecord }
  | {
      type: "agent.terminal_state_changed";
      agentId: string;
      terminalState: TerminalUiState;
    }
  | {
      type: "agent.diff_state_changed";
      agentId: string;
      diffStats: DiffStats | null;
    }
  | { type: "agent.deleted"; agentId: string }
  | { type: "media.changed"; agentId: string }
  | {
      type: "whiteboard.changed";
      agentId: string;
      version: number;
      source: "user" | "agent";
    }
  | { type: "media.seen"; agentId: string; keys: string[] }
  | {
      type: "message.created";
      senderAgentId: string;
      recipientAgentId: string;
    }
  | { type: "message.read"; agentId: string }
  | { type: "stream.started"; agentId: string }
  | { type: "stream.stopped"; agentId: string }
  | {
      type: "review.created";
      agentId: string;
      reviewId: number;
      reviewerAgentId?: string | null;
    }
  | {
      type: "review.updated";
      agentId: string;
      reviewId: number;
      status: string;
    }
  | {
      type: "review_feedback.updated";
      agentId: string;
      feedbackItemId: number;
    }
  | { type: "job.changed" }
  | { type: "template.changed" }
  | { type: "brain.changed"; repoRoot: string }
  | {
      type: "notification";
      notificationId: string;
      agentId: string;
      agentName: string;
      eventType: string;
      message: string;
    }
  | {
      type: "release.cached_info_changed";
      snapshot: ReleaseInfoSnapshot | null;
    };

export class UiEventBroker {
  private clients = new Set<NodeJS.WritableStream>();
  private snapshotBuffers = new Map<NodeJS.WritableStream, UiEvent[]>();
  private nextId = 1;
  private eventsPublished = 0;
  private writeFailures = 0;

  subscribe(
    stream: NodeJS.WritableStream,
    options?: { bufferUntilSnapshot?: boolean }
  ): () => void {
    this.clients.add(stream);
    if (options?.bufferUntilSnapshot) {
      this.snapshotBuffers.set(stream, []);
    }
    return () => {
      this.clients.delete(stream);
      this.snapshotBuffers.delete(stream);
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

  sendSnapshot(stream: NodeJS.WritableStream, agents: AgentRecord[]): void {
    this.write({ type: "snapshot", agents }, stream);
    this.flushSnapshot(stream);
  }

  flushSnapshot(stream: NodeJS.WritableStream): void {
    const buffered = this.snapshotBuffers.get(stream);
    if (!buffered) return;
    this.snapshotBuffers.delete(stream);
    for (const event of buffered) {
      this.write(event, stream);
    }
  }

  private write(event: UiEvent, target?: NodeJS.WritableStream): void {
    const payload = `id: ${this.nextId++}\ndata: ${JSON.stringify(event)}\n\n`;
    if (target) {
      target.write(payload);
      return;
    }

    for (const client of this.clients) {
      const buffered = this.snapshotBuffers.get(client);
      if (buffered) {
        buffered.push(event);
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
