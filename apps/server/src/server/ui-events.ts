import type { AgentRecord, FeedbackRecord } from "../agents/manager.js";
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
  | { type: "media.seen"; agentId: string; keys: string[] }
  | { type: "stream.started"; agentId: string }
  | { type: "stream.stopped"; agentId: string }
  | {
      type: "feedback.created";
      agentId: string;
      feedback: FeedbackRecord;
    }
  | {
      type: "feedback.updated";
      agentId: string;
      feedback: FeedbackRecord;
    }
  | { type: "job.changed" }
  | {
      type: "notification";
      notificationId: string;
      agentId: string;
      agentName: string;
      eventType: string;
      message: string;
    };

export class UiEventBroker {
  private clients = new Set<NodeJS.WritableStream>();
  private nextId = 1;

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
    this.write(event);
  }

  sendSnapshot(stream: NodeJS.WritableStream, agents: AgentRecord[]): void {
    this.write({ type: "snapshot", agents }, stream);
  }

  private write(event: UiEvent, target?: NodeJS.WritableStream): void {
    const payload = `id: ${this.nextId++}\ndata: ${JSON.stringify(event)}\n\n`;
    if (target) {
      target.write(payload);
      return;
    }

    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}
