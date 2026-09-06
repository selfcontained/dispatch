import type {
  ChatMessage,
  HarnessPrompt,
  HarnessQueuedPrompt,
  HarnessQuestion,
  HarnessStep,
  HarnessTurn,
} from "@dispatch/shared";

import { type Queryable, toChatMessage } from "../../chat/store.js";
import type { PromptSource } from "./prompt-source.js";
import { subagentIdFromOutput } from "./subagents.js";
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

/** dsh's read tool wraps its result as <path>…</path><type>…</type><content>…. */
const READ_PATH_TAG = /^<path>([^<]+)<\/path>/;

/**
 * dsh sends no ACP `locations`; the paths live in the tool's raw input
 * (file_path, path, pattern) or, for read, in the output wrapper.
 */
export function locationsFromInput(
  input: unknown,
  terminalOutput: string | null | undefined
): { path: string; line?: number }[] {
  const obj =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  const path = obj
    ? [obj.file_path, obj.path, obj.filePath, obj.file].find(
        (v): v is string => typeof v === "string" && v.length > 0
      )
    : undefined;
  if (path) {
    const line =
      typeof obj?.offset === "number" && obj.offset > 1
        ? obj.offset
        : typeof obj?.line === "number"
          ? obj.line
          : undefined;
    return [line !== undefined ? { path, line } : { path }];
  }
  const tagged = terminalOutput ? READ_PATH_TAG.exec(terminalOutput) : null;
  return tagged ? [{ path: tagged[1] }] : [];
}

const LABEL_MAX = 80;

/** A dispatch_event call's type and message, when the row is one. */
function statusEventOf(
  row: TurnSourceRow
): { type: string; message: string } | null {
  const p = row.payload as Partial<ToolPayload>;
  if (p.title !== "mcp__dispatch__dispatch_event") return null;
  const input = p.input;
  if (typeof input !== "object" || input === null) return null;
  const { type, message } = input as { type?: unknown; message?: unknown };
  if (typeof type !== "string" || typeof message !== "string") return null;
  const trimmed = message.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return {
    type,
    message:
      trimmed.length > LABEL_MAX
        ? `${trimmed.slice(0, LABEL_MAX - 1)}…`
        : trimmed,
  };
}

function toolStep(row: TurnSourceRow): HarnessStep | null {
  const p = row.payload as Partial<ToolPayload>;
  const title = p.title ?? "";
  if (DROPPED_TOOL_TITLES.has(title)) return null;
  const settled = p.status === "completed" || p.status === "failed";
  // dsh's subagent tool answers "started subagent <id>"; the view opens
  // that session under the step, so the id travels as data, not as text
  // for the view to re-parse.
  const subagentId =
    title === "subagent" ? subagentIdFromOutput(p.terminalOutput) : null;
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
      locations: p.locations?.length
        ? p.locations
        : locationsFromInput(p.input, p.terminalOutput),
      diff: p.diff ?? null,
      terminalOutput: p.terminalOutput ?? null,
      ...(p.truncated ? { truncated: true } : {}),
      ...(p.input !== undefined ? { input: p.input } : {}),
      ...(subagentId ? { subagentSessionId: subagentId } : {}),
    },
  };
}

function noteStep(
  row: TurnSourceRow,
  kind: "note" | "think",
  running = false
): HarnessStep {
  const p = row.payload as Partial<AssistantPayload & ThoughtPayload>;
  const text = p.text ?? "";
  return {
    id: `stream:${row.id}`,
    kind,
    label: kind === "think" ? "thinking" : firstLine(text),
    status: running ? "running" : "ok",
    startedAt: row.createdAt.toISOString(),
    ...(running
      ? {}
      : {
          endedAt: row.updatedAt.toISOString(),
          // Thought rows grow with each chunk, so their span is the time
          // the model spent thinking; the rail shows it like any step.
          durMs: Math.max(0, row.updatedAt.getTime() - row.createdAt.getTime()),
        }),
    detail: { text, ...(p.truncated ? { truncated: true } : {}) },
  };
}

type Group = { turn: TurnSourceRow | null; rows: TurnSourceRow[] };

/** An agent question as the view carries it. */
function toQuestion(message: ChatMessage): HarnessQuestion {
  return {
    id: message.id,
    text: message.text,
    options: message.question?.options ?? [],
    allowFreeform: message.question?.allowFreeform === true,
    answer: message.answer
      ? {
          value: message.answer.value,
          ...(message.answer.label ? { label: message.answer.label } : {}),
        }
      : null,
    createdAt: message.createdAt,
  };
}

/** Cut ascending stream rows into turns and shape each for the view. */
export function assembleTurns(
  rows: TurnSourceRow[],
  chat: Map<string, ChatMessage>,
  questions: ChatMessage[] = []
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
  // Each question belongs to the latest turn that had started when it was
  // posted; one posted before any turn goes with the first.
  const starts = groups.map((g) => (g.turn ?? g.rows[0]).createdAt.getTime());
  const byGroup = new Map<number, HarnessQuestion[]>();
  for (const message of [...questions].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
  )) {
    const at = Date.parse(message.createdAt);
    let index = 0;
    for (let i = 0; i < starts.length; i += 1) {
      if (starts[i] <= at) index = i;
    }
    const list = byGroup.get(index) ?? [];
    list.push(toQuestion(message));
    byGroup.set(index, list);
  }
  return groups.map((group, index) => {
    const turnPayload = group.turn ? (group.turn.payload as TurnPayload) : null;
    const anchor = group.turn ?? group.rows[0];
    const startedAt = anchor.createdAt.toISOString();
    const turnQuestions = byGroup.get(index);
    const settled = turnPayload?.state === "settled";
    const steps: HarnessStep[] = [];
    let result: HarnessTurn["result"] = null;
    const assistants = group.rows.filter((r) => r.kind === "assistant");
    const last = assistants[assistants.length - 1];
    // In a turn still running, a thought that is the newest row is the one
    // being written now: it reads as a running step, not a finished one.
    const live = group.turn !== null && !settled;
    const newest = group.rows[group.rows.length - 1];
    // The agent's own account of the turn: dispatch_event messages are
    // dropped as steps but the last one names what happened. A terminal
    // event (done, idle, …) wins over the last "working".
    let label: string | undefined;
    let labelTerminal = false;
    for (const row of group.rows) {
      if (row.kind === "tool_call") {
        const status = statusEventOf(row);
        if (status) {
          const terminal = status.type !== "working";
          if (terminal || !labelTerminal) {
            label = status.message;
            labelTerminal = terminal;
          }
        }
        const step = toolStep(row);
        if (step) steps.push(step);
      } else if (row.kind === "thought") {
        steps.push(noteStep(row, "think", live && row === newest));
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
      ...(turnQuestions ? { questions: turnQuestions } : {}),
      ...(label ? { label } : {}),
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
  const chat = await loadChatMessages(db, chatIds);
  // Agent questions posted since the window opened (Chat shows them; a
  // harness agent's pane does not).
  const since = source.length ? source[0].createdAt : new Date(0);
  const asked = await db.query(
    `SELECT * FROM agent_chat_messages
      WHERE agent_id = $1 AND author_kind = 'agent' AND kind = 'question'
        AND created_at >= $2
      ORDER BY created_at ASC`,
    [agentId, since]
  );
  const questions = asked.rows.map((row) => toChatMessage(row as never));
  return assembleTurns(source, chat, questions);
}

/** The chat messages behind chat-sourced prompts, by id. */
async function loadChatMessages(
  db: Queryable,
  ids: string[]
): Promise<Map<string, ChatMessage>> {
  const chat = new Map<string, ChatMessage>();
  if (ids.length === 0) return chat;
  const messages = await db.query(
    `SELECT * FROM agent_chat_messages WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  for (const row of messages.rows) {
    const message = toChatMessage(row as never);
    chat.set(message.id, message);
  }
  return chat;
}

/** The supervisor's queue, shaped for the view with chat text joined. */
export async function loadQueued(
  db: Queryable,
  queued: { id: string; source: PromptSource; createdAt: string }[]
): Promise<HarnessQueuedPrompt[]> {
  const chat = await loadChatMessages(
    db,
    queued
      .map((q) => q.source)
      .filter(
        (p): p is Extract<PromptSource, { source: "chat" }> =>
          p.source === "chat"
      )
      .map((p) => p.chatMessageId)
  );
  return queued.map((q) => ({
    ...promptFor(q.source, chat),
    id: q.id,
    createdAt: q.createdAt,
  }));
}
