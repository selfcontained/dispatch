import type { DriverEvent, DriverUpdate } from "./driver.js";
import type { StreamEventRow, StreamStore } from "./stream-store.js";

type TextKind = "assistant" | "thought";

type OpenText = { row: StreamEventRow; text: string };

/** Payload shape of a `tool_call` row; the Chat feed reads these fields. */
export type ToolPayload = {
  toolKind: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  locations: { path: string; line?: number }[];
  diff: { path: string; oldText: string | null; newText: string } | null;
  terminalOutput: string | null;
};

function textOf(content: { type: string; text?: string } | undefined): string {
  return content && content.type === "text" && typeof content.text === "string"
    ? content.text
    : "";
}

function projectLocations(
  locations:
    | readonly { path: string; line?: number | null }[]
    | null
    | undefined
): ToolPayload["locations"] {
  return (locations ?? []).map((l) =>
    l.line != null ? { path: l.path, line: l.line } : { path: l.path }
  );
}

function projectToolContent(content: readonly unknown[] | null | undefined): {
  diff: ToolPayload["diff"];
  terminalOutput: string | null;
} {
  let diff: ToolPayload["diff"] = null;
  let terminalOutput: string | null = null;
  for (const item of content ?? []) {
    const c = item as {
      type: string;
      path?: string;
      oldText?: string | null;
      newText?: string;
      content?: { type: string; text?: string };
    };
    if (c.type === "diff" && c.path && typeof c.newText === "string") {
      diff = { path: c.path, oldText: c.oldText ?? null, newText: c.newText };
    } else if (c.type === "content" && c.content?.type === "text") {
      terminalOutput = (terminalOutput ?? "") + (c.content.text ?? "");
    }
  }
  return { diff, terminalOutput };
}

/**
 * Folds driver events into `agent_stream_events` rows. Assistant and
 * thought chunks accumulate into one open row each until something else
 * interrupts them (a tool call, a settled turn, a process exit); tool calls
 * are keyed by toolCallId and rewritten as they settle. One instance serves
 * every agent; open-row state is per agent.
 */
export class StreamRecorder {
  private readonly open = new Map<
    string,
    Partial<Record<TextKind, OpenText>>
  >();

  constructor(private readonly store: StreamStore) {}

  async handle(event: DriverEvent): Promise<void> {
    switch (event.type) {
      case "update":
        return this.handleUpdate(event.agentId, event.update);
      case "turn":
        if (event.state === "settled") {
          await this.closeText(event.agentId);
          if (event.error) {
            await this.store.append(event.agentId, "status", {
              message: event.error,
            });
          }
        }
        return;
      case "exit": {
        await this.closeText(event.agentId);
        if (event.code === 0) return;
        const how =
          event.code === null ? `signal ${event.signal}` : `code ${event.code}`;
        const detail = event.stderrTail ? `: ${event.stderrTail}` : "";
        await this.store.append(event.agentId, "status", {
          message: `dsh exited with ${how}${detail}`,
        });
        return;
      }
    }
  }

  private async handleUpdate(
    agentId: string,
    update: DriverUpdate
  ): Promise<void> {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return this.appendText(agentId, "assistant", textOf(update.content));
      case "agent_thought_chunk":
        return this.appendText(agentId, "thought", textOf(update.content));
      case "tool_call": {
        await this.closeText(agentId);
        const { diff, terminalOutput } = projectToolContent(update.content);
        const payload: ToolPayload = {
          toolKind: update.kind ?? "other",
          title: update.title,
          status: update.status ?? "pending",
          locations: projectLocations(update.locations),
          diff,
          terminalOutput,
        };
        await this.store.upsertByKey(
          agentId,
          "tool_call",
          update.toolCallId,
          payload
        );
        return;
      }
      case "tool_call_update": {
        // An update for a call we never saw start still gets a row, so a
        // late-joining feed shows the settled call.
        const existing =
          (await this.store.getByKey(
            agentId,
            "tool_call",
            update.toolCallId
          )) ??
          (await this.store.append(
            agentId,
            "tool_call",
            {},
            update.toolCallId
          ));
        const prev = existing.payload as Partial<ToolPayload>;
        const projected = update.content
          ? projectToolContent(update.content)
          : null;
        const next: ToolPayload = {
          toolKind: update.kind ?? prev.toolKind ?? "other",
          title: update.title ?? prev.title ?? "",
          status: update.status ?? prev.status ?? "pending",
          locations: update.locations
            ? projectLocations(update.locations)
            : (prev.locations ?? []),
          diff: projected?.diff ?? prev.diff ?? null,
          terminalOutput:
            projected?.terminalOutput ?? prev.terminalOutput ?? null,
        };
        await this.store.updatePayload(existing.id, next);
        return;
      }
      default:
        return;
    }
  }

  private async appendText(
    agentId: string,
    kind: TextKind,
    delta: string
  ): Promise<void> {
    if (!delta) return;
    const state = this.open.get(agentId) ?? {};
    const other: TextKind = kind === "assistant" ? "thought" : "assistant";
    if (state[other]) await this.closeText(agentId, other);
    let current = state[kind];
    if (!current) {
      const row = await this.store.append(
        agentId,
        kind,
        kind === "assistant"
          ? { text: delta, streaming: true }
          : { text: delta }
      );
      current = { row, text: delta };
    } else {
      current.text += delta;
      await this.store.updatePayload(
        current.row.id,
        kind === "assistant"
          ? { text: current.text, streaming: true }
          : { text: current.text }
      );
    }
    state[kind] = current;
    this.open.set(agentId, state);
  }

  private async closeText(agentId: string, only?: TextKind): Promise<void> {
    const state = this.open.get(agentId);
    if (!state) return;
    for (const kind of ["assistant", "thought"] as const) {
      if (only && kind !== only) continue;
      const current = state[kind];
      if (!current) continue;
      await this.store.updatePayload(
        current.row.id,
        kind === "assistant"
          ? { text: current.text, streaming: false }
          : { text: current.text }
      );
      delete state[kind];
    }
    if (!state.assistant && !state.thought) this.open.delete(agentId);
  }
}
