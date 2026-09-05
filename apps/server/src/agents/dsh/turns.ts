import type {
  ChatMessage,
  HarnessPrompt,
  HarnessStep,
  HarnessTurn,
} from "@dispatch/shared";

import { type Queryable, toChatMessage } from "../../chat/store.js";
import type { PromptSource } from "./prompt-source.js";
import type {
  AssistantPayload,
  StreamEventRow,
  ThoughtPayload,
  ToolPayload,
  TurnPayload,
} from "./stream-store.js";

export type TurnSourceRow = Pick<
  StreamEventRow,
  "id" | "seq" | "kind" | "payload" | "createdAt" | "updatedAt"
>;

/** The agent's own status reports already show as status lines; in a trace they are noise. */
const DROPPED_TOOL_TITLES = new Set(["mcp__dispatch__dispatch_event"]);

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

function promptFor(
  source: PromptSource,
  chat: Map<string, ChatMessage>
): HarnessPrompt {
  if (source.source === "chat") {
    const message = chat.get(source.chatMessageId);
    return {
      source: message?.origin === "launch" ? "launch" : "chat",
      text: message?.text ?? "",
      chatMessageId: source.chatMessageId,
      attachments: message?.attachments ?? [],
    };
  }
  if (source.source === "agent") {
    return {
      source: "agent",
      text: source.text,
      senderName: source.senderName,
      attachments: [],
    };
  }
  return { source: "system", text: source.text, attachments: [] };
}

function toolStep(row: TurnSourceRow): HarnessStep | null {
  const p = row.payload as Partial<ToolPayload>;
  const title = p.title ?? "";
  if (DROPPED_TOOL_TITLES.has(title)) return null;
  const settled = p.status === "completed" || p.status === "failed";
  return {
    id: `stream:${row.id}`,
    kind: p.toolKind ?? "other",
    label: title,
    status:
      p.status === "completed"
        ? "ok"
        : p.status === "failed"
          ? "error"
          : "running",
    startedAt: row.createdAt.toISOString(),
    ...(settled
      ? {
          endedAt: row.updatedAt.toISOString(),
          durMs: Math.max(0, row.updatedAt.getTime() - row.createdAt.getTime()),
        }
      : {}),
    detail: {
      toolKind: p.toolKind,
      locations: p.locations ?? [],
      diff: p.diff ?? null,
      terminalOutput: p.terminalOutput ?? null,
      ...(p.truncated ? { truncated: true } : {}),
    },
  };
}

function noteStep(row: TurnSourceRow, kind: "note" | "think"): HarnessStep {
  const p = row.payload as Partial<AssistantPayload & ThoughtPayload>;
  const text = p.text ?? "";
  return {
    id: `stream:${row.id}`,
    kind,
    label: kind === "think" ? "thinking" : firstLine(text),
    status: "ok",
    startedAt: row.createdAt.toISOString(),
    endedAt: row.updatedAt.toISOString(),
    detail: { text, ...(p.truncated ? { truncated: true } : {}) },
  };
}

type Group = { turn: TurnSourceRow | null; rows: TurnSourceRow[] };

/** Cut ascending stream rows into turns and shape each for the view. */
export function assembleTurns(
  rows: TurnSourceRow[],
  chat: Map<string, ChatMessage>
): HarnessTurn[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const row of rows) {
    if (row.kind === "turn") {
      current = { turn: row, rows: [] };
      groups.push(current);
      continue;
    }
    if (!current) {
      current = { turn: null, rows: [] };
      groups.push(current);
    }
    current.rows.push(row);
  }
  return groups.map((group, index) => {
    const turnPayload = group.turn ? (group.turn.payload as TurnPayload) : null;
    const anchor = group.turn ?? group.rows[0];
    const startedAt = anchor.createdAt.toISOString();
    const settled = turnPayload?.state === "settled";
    const steps: HarnessStep[] = [];
    let result: HarnessTurn["result"] = null;
    const assistants = group.rows.filter((r) => r.kind === "assistant");
    const last = assistants[assistants.length - 1];
    for (const row of group.rows) {
      if (row.kind === "tool_call") {
        const step = toolStep(row);
        if (step) steps.push(step);
      } else if (row.kind === "thought") {
        steps.push(noteStep(row, "think"));
      } else if (row.kind === "assistant") {
        if (row === last) {
          const p = row.payload as Partial<AssistantPayload>;
          result = {
            text: p.text ?? "",
            streaming: p.streaming === true && !settled,
            ...(p.truncated ? { truncated: true } : {}),
          };
        } else {
          steps.push(noteStep(row, "note"));
        }
      }
    }
    const error = turnPayload?.error;
    const lastRow = group.rows[group.rows.length - 1];
    const trace: HarnessTurn["trace"] = { startedAt, steps };
    if (settled) {
      if (turnPayload?.endedAt) trace.endedAt = turnPayload.endedAt;
      trace.finalResult = error ? "error" : "ok";
    } else if (!group.turn && lastRow) {
      // Rows from before turn rows existed: one closed synthetic turn.
      trace.endedAt = lastRow.updatedAt.toISOString();
      trace.finalResult = "ok";
    }
    return {
      id: group.turn ? `turn:${group.turn.id}` : `turn:pre:${index}`,
      prompt: turnPayload
        ? promptFor(turnPayload.prompt, chat)
        : { source: "system", text: "Earlier activity", attachments: [] },
      trace,
      result,
      ...(error ? { error } : {}),
    };
  });
}

/** The newest `limit` turns for an agent, with their chat prompts joined. */
export async function loadTurns(
  db: Queryable,
  agentId: string,
  limit: number
): Promise<HarnessTurn[]> {
  // The newest `limit` turn rows bound the window; everything from the
  // oldest of them onward is one contiguous slice of the stream.
  const boundary = await db.query<{ seq: number }>(
    `SELECT seq FROM agent_stream_events
      WHERE agent_id = $1 AND kind = 'turn'
      ORDER BY seq DESC LIMIT $2`,
    [agentId, limit]
  );
  const fromSeq = boundary.rows.length
    ? boundary.rows[boundary.rows.length - 1].seq
    : 0;
  const rows = await db.query<{
    id: number | string;
    seq: number;
    kind: StreamEventRow["kind"];
    payload: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, seq, kind, payload, created_at, updated_at
       FROM agent_stream_events
      WHERE agent_id = $1 AND seq >= $2
      ORDER BY seq ASC`,
    [agentId, fromSeq]
  );
  const source: TurnSourceRow[] = rows.rows.map((r) => ({
    id: Number(r.id),
    seq: r.seq,
    kind: r.kind,
    payload: r.payload,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  const chatIds = source
    .filter((r) => r.kind === "turn")
    .map((r) => (r.payload as TurnPayload).prompt)
    .filter(
      (p): p is Extract<PromptSource, { source: "chat" }> => p.source === "chat"
    )
    .map((p) => p.chatMessageId);
  const chat = new Map<string, ChatMessage>();
  if (chatIds.length) {
    const messages = await db.query(
      `SELECT * FROM agent_chat_messages WHERE id = ANY($1::text[])`,
      [chatIds]
    );
    for (const row of messages.rows) {
      const message = toChatMessage(row as never);
      chat.set(message.id, message);
    }
  }
  return assembleTurns(source, chat);
}
