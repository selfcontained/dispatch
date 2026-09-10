import type {
  ChatMessage,
  ChatTurnEntry,
  ChatTurnPlanEntry,
  ChatTurnQuestionRef,
  ChatTurnStep,
  HarnessPrompt,
  HarnessQueuedPrompt,
  HarnessQuestion,
} from "@dispatch/shared";

import {
  AT_KEY_SQL,
  cursorClause,
  type FeedCursor,
  intKey,
  type Keyed,
} from "./feed-cursor.js";

import { INTERRUPTED_BY_RESTART } from "../agents/harness/stream-recorder.js";
import type { PromptSource } from "../agents/harness/prompt-source.js";
import type {
  AssistantPayload,
  PlanPayload,
  StreamEventRow,
  ThoughtPayload,
  ToolPayload,
  TurnPayload,
} from "../agents/harness/stream-store.js";
import { isChatMessageId, type Queryable, toChatMessage } from "./store.js";

export type TurnSourceRow = Pick<
  StreamEventRow,
  "id" | "seq" | "kind" | "key" | "payload" | "createdAt" | "updatedAt"
>;

/**
 * A turn as the assembler shapes it, on the way to the feed entry
 * `toTurnEntry` frames from it. Not a wire type: `toTurnEntry` is its only
 * reader, and it carries each question whole because the entry needs the
 * answer state off it.
 */
export type AssembledTurn = {
  id: string;
  prompt: HarnessPrompt;
  trace: {
    startedAt: string;
    endedAt?: string;
    /** `interrupted`: the turn was cancelled (Stop, Ctrl+C, Send now). */
    finalResult?: "ok" | "error" | "interrupted";
    steps: ChatTurnStep[];
  };
  result: { text: string; streaming: boolean; truncated?: boolean } | null;
  error?: string;
  /** Questions the agent asked during this turn, oldest first. */
  questions?: HarnessQuestion[];
  /**
   * What the turn did, in the agent's own words: the message of the last
   * dispatch_event it sent during the turn ("Answered README question").
   * Absent when the agent sent none.
   */
  label?: string;
  /** The task list as the engine last published it during this turn. */
  plan?: ChatTurnPlanEntry[];
  /** Context used and, where the engine reports it, cost so far in this session. */
  usage?: { used: number; size: number; costUsd: number | null };
};

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

/** The engine's read tool wraps its result as <path>…</path><type>…</type><content>…. */
const READ_PATH_TAG = /^<path>([^<]+)<\/path>/;

/**
 * The engine sends no ACP `locations`; the paths live in the tool's raw
 * input (file_path, path, pattern) or, for read, in the output wrapper.
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

function toolStep(row: TurnSourceRow): ChatTurnStep | null {
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
      locations: p.locations?.length
        ? p.locations
        : locationsFromInput(p.input, p.terminalOutput),
      diff: p.diff ?? null,
      terminalOutput: p.terminalOutput ?? null,
      ...(p.truncated ? { truncated: true } : {}),
      ...(p.input !== undefined ? { input: p.input } : {}),
      ...(p.parentToolCallId ? { parentToolCallId: p.parentToolCallId } : {}),
    },
  };
}

function noteStep(
  row: TurnSourceRow,
  kind: "note" | "think",
  running = false
): ChatTurnStep {
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

/** One turn's rows: its `turn` row (null for a pre-turn group) and the rest. */
export type TurnGroup = { turn: TurnSourceRow | null; rows: TurnSourceRow[] };

/**
 * Cut ascending stream rows into turns at each `turn` row. Rows before the
 * first one form a single leading group with no turn row of its own: that
 * is history from before turn rows existed, and it assembles into one
 * closed synthetic turn. Callers rely on the result indexing one to one
 * with {@link assembleTurns} over the same rows.
 */
export function groupTurnRows(rows: TurnSourceRow[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: TurnGroup | null = null;
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
  return groups;
}

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

/**
 * Hang each step that names a parent under that parent, in stream order.
 * A parent outside the turn (or dropped as a status event) leaves the child
 * at the top level rather than losing it.
 */
function nestSteps(
  flat: { step: ChatTurnStep; key: string | null; parent: string | null }[]
): ChatTurnStep[] {
  const byKey = new Map<string, ChatTurnStep>();
  for (const { step, key } of flat) if (key) byKey.set(key, step);
  const top: ChatTurnStep[] = [];
  for (const { step, parent } of flat) {
    const owner = parent ? byKey.get(parent) : undefined;
    if (owner && owner !== step) (owner.children ??= []).push(step);
    else top.push(step);
  }
  return top;
}

function planEntriesOf(row: TurnSourceRow): ChatTurnPlanEntry[] {
  const p = row.payload as Partial<PlanPayload>;
  return (p.entries ?? []).map((e) => ({
    content: e.content,
    status: e.status as ChatTurnPlanEntry["status"],
    priority: e.priority as ChatTurnPlanEntry["priority"],
  }));
}

/** Cut ascending stream rows into turns and shape each for the view. */
export function assembleTurns(
  rows: TurnSourceRow[],
  chat: Map<string, ChatMessage>,
  questions: ChatMessage[] = []
): AssembledTurn[] {
  const groups = groupTurnRows(rows);
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
    let result: AssembledTurn["result"] = null;
    const assistants = group.rows.filter((r) => r.kind === "assistant");
    const last = assistants[assistants.length - 1];
    // In a turn still running, a thought that is the newest row is the one
    // being written now: it reads as a running step, not a finished one.
    const live = group.turn !== null && !settled;
    const newest = group.rows[group.rows.length - 1];
    // The agent's own account of the turn: dispatch_event messages are
    // dropped as steps but the last one names what happened. A terminal
    // event (done, idle, …) wins over the last "working".
    const flat: {
      step: ChatTurnStep;
      key: string | null;
      parent: string | null;
    }[] = [];
    let plan: ChatTurnPlanEntry[] | undefined;
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
        if (step) {
          flat.push({
            step,
            key: row.key,
            parent:
              (row.payload as Partial<ToolPayload>).parentToolCallId ?? null,
          });
        }
      } else if (row.kind === "thought") {
        flat.push({
          step: noteStep(row, "think", live && row === newest),
          key: null,
          parent: null,
        });
      } else if (row.kind === "assistant") {
        if (row === last) {
          const p = row.payload as Partial<AssistantPayload>;
          result = {
            text: p.text ?? "",
            streaming: p.streaming === true && !settled,
            ...(p.truncated ? { truncated: true } : {}),
          };
        } else {
          flat.push({ step: noteStep(row, "note"), key: null, parent: null });
        }
      } else if (row.kind === "plan") {
        plan = planEntriesOf(row);
      }
    }
    const steps = nestSteps(flat);
    const error = turnPayload?.error;
    const lastRow = group.rows[group.rows.length - 1];
    const trace: AssembledTurn["trace"] = { startedAt, steps };
    if (settled) {
      if (turnPayload?.endedAt) trace.endedAt = turnPayload.endedAt;
      trace.finalResult = error
        ? "error"
        : turnPayload?.stopReason === "cancelled"
          ? "interrupted"
          : "ok";
    } else if (!group.turn && lastRow) {
      // Rows from before turn rows existed: one closed synthetic turn.
      trace.endedAt = lastRow.updatedAt.toISOString();
      trace.finalResult = "ok";
    }
    const usage = turnPayload?.usage
      ? {
          used: turnPayload.usage.used,
          size: turnPayload.usage.size,
          costUsd:
            turnPayload.usage.cost && turnPayload.usage.cost.currency === "USD"
              ? turnPayload.usage.cost.amount
              : null,
        }
      : undefined;
    return {
      // A pre-turn group is named by its first row, not by its position, so
      // a feed cursor over it compares against a real row id.
      id: group.turn ? `turn:${group.turn.id}` : `turn:pre:${group.rows[0].id}`,
      prompt: turnPayload
        ? promptFor(turnPayload.prompt, chat)
        : { source: "system", text: "Earlier activity", attachments: [] },
      trace,
      result,
      ...(turnQuestions ? { questions: turnQuestions } : {}),
      ...(label ? { label } : {}),
      ...(error ? { error } : {}),
      ...(plan ? { plan } : {}),
      ...(usage ? { usage } : {}),
    };
  });
}

/**
 * One assembled turn as the feed row it is. The anchor's `created_at` fixes
 * the entry's place for the turn's life; `updatedAt` moves with the newest
 * row folded into it, which is what makes a streaming turn follow the
 * scroll. Questions become references: their cards are `chat` entries of
 * their own, in time order, so the turn only says which ones it asked.
 */
export function toTurnEntry(
  turn: AssembledTurn,
  group: TurnGroup,
  agentId: string
): ChatTurnEntry {
  const anchor = group.turn ?? group.rows[0];
  const payload = group.turn ? (group.turn.payload as TurnPayload) : null;
  // A group with no turn row is closed by definition: it is history from
  // before turn rows existed. Otherwise the row itself says so.
  const settled = payload === null || payload.state === "settled";
  let updatedAt = anchor.updatedAt;
  for (const row of group.rows) {
    if (row.updatedAt > updatedAt) updatedAt = row.updatedAt;
  }
  // A turn the service went down under settles carrying the restart marker
  // as its error. That is a cut, not a failure the engine reported, so the
  // entry says `interrupted` and drops the marker rather than showing it as
  // an error line under the result.
  const byRestart = payload?.error === INTERRUPTED_BY_RESTART;
  const trace: ChatTurnEntry["trace"] = byRestart
    ? { ...turn.trace, finalResult: "interrupted" }
    : turn.trace;
  const error = byRestart ? undefined : turn.error;
  const questions: ChatTurnQuestionRef[] | undefined = turn.questions?.map(
    (q) => ({ messageId: q.id, answered: q.answer !== null })
  );
  return {
    type: "turn",
    id: turn.id,
    agentId,
    at: anchor.createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    prompt: turn.prompt,
    trace,
    result: turn.result,
    settled,
    interrupted: trace.finalResult === "interrupted",
    ...(error ? { error } : {}),
    ...(turn.label ? { label: turn.label } : {}),
    ...(turn.plan ? { plan: turn.plan } : {}),
    ...(turn.usage ? { usage: turn.usage } : {}),
    ...(questions ? { questions } : {}),
  };
}

type StreamRowResult = {
  id: number | string;
  seq: number;
  kind: StreamEventRow["kind"];
  key: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  at_key: string;
};

/**
 * One page of turn entries, newest first, past `cursor`.
 *
 * The anchors are the `turn` rows, plus the agent's oldest stream row when
 * that row is not itself a turn row: the rows recorded before turn rows
 * existed assemble into one closed synthetic turn, and it needs an anchor
 * of its own to sort and page by. The page's rows are everything from the
 * oldest selected anchor up to, but not including, the first turn row above
 * the page, so paging older never re-reads a newer turn and a turn belongs
 * wholly to the page its anchor falls on.
 */
export async function listTurnEntries(
  db: Queryable,
  agentId: string,
  cursor: FeedCursor | null,
  limit: number
): Promise<Keyed<ChatTurnEntry>[]> {
  const params: unknown[] = [agentId];
  const clause = cursorClause("turn", "int", cursor, params);
  params.push(limit);
  const anchors = await db.query<{ id: number | string; seq: number }>(
    `SELECT id, seq
       FROM agent_stream_events
      WHERE agent_id = $1
        AND (
          kind = 'turn'
          OR seq = (
            SELECT min(seq) FROM agent_stream_events WHERE agent_id = $1
          )
        ) ${clause}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params
  );
  if (anchors.rows.length === 0) return [];
  const seqs = anchors.rows.map((r) => r.seq);
  const fromSeq = Math.min(...seqs);
  const maxSeq = Math.max(...seqs);
  const above = await db.query<{ seq: number; created_at: Date }>(
    `SELECT seq, created_at
       FROM agent_stream_events
      WHERE agent_id = $1 AND kind = 'turn' AND seq > $2
      ORDER BY seq ASC
      LIMIT 1`,
    [agentId, maxSeq]
  );
  const untilSeq = above.rows[0]?.seq ?? null;
  const untilAt = above.rows[0]?.created_at ?? null;
  const rows = await db.query<StreamRowResult>(
    `SELECT id, seq, kind, key, payload, created_at, updated_at,
            ${AT_KEY_SQL} AS at_key
       FROM agent_stream_events
      WHERE agent_id = $1 AND seq >= $2
        AND ($3::int IS NULL OR seq < $3)
      ORDER BY seq ASC`,
    [agentId, fromSeq, untilSeq]
  );
  const source: TurnSourceRow[] = [];
  // The cursor needs the anchor row's microsecond time, which only Postgres
  // can render exactly; the ISO form the entry exposes is milliseconds.
  const atKeyById = new Map<number, string>();
  for (const r of rows.rows) {
    const id = Number(r.id);
    atKeyById.set(id, r.at_key);
    source.push({
      id,
      seq: r.seq,
      kind: r.kind,
      key: r.key,
      payload: r.payload,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }
  const chat = await loadChatMessages(db, chatPromptIds(source));
  // Questions the agent asked while this page's turns ran. Bounded above as
  // well as below: a question from a newer turn would otherwise attach to
  // this page's last turn, which is the one that had started when it landed.
  const since = source.length ? source[0].createdAt : new Date(0);
  const asked = await db.query(
    `SELECT * FROM agent_chat_messages
      WHERE agent_id = $1 AND author_kind = 'agent' AND kind = 'question'
        AND created_at >= $2
        AND ($3::timestamptz IS NULL OR created_at < $3)
      ORDER BY created_at ASC`,
    [agentId, since, untilAt]
  );
  const questions = asked.rows.map((row) => toChatMessage(row as never));
  const groups = groupTurnRows(source);
  const turns = assembleTurns(source, chat, questions);
  const keyed: Keyed<ChatTurnEntry>[] = [];
  turns.forEach((turn, index) => {
    const group = groups[index];
    if (!group) return;
    const anchor = group.turn ?? group.rows[0];
    const atKey = atKeyById.get(anchor.id);
    if (atKey === undefined) return;
    keyed.push({
      entry: toTurnEntry(turn, group, agentId),
      atKey,
      rawId: String(anchor.id),
      idKey: intKey(anchor.id),
    });
  });
  // Assembly runs oldest first; the feed merges newest first.
  return keyed.reverse();
}

/** The chat message ids the page's turn rows name as their prompt. */
function chatPromptIds(rows: TurnSourceRow[]): string[] {
  return rows
    .filter((r) => r.kind === "turn")
    .map((r) => (r.payload as TurnPayload).prompt)
    .filter(
      (p): p is Extract<PromptSource, { source: "chat" }> => p.source === "chat"
    )
    .map((p) => p.chatMessageId);
}

/**
 * The agent's newest turn as one feed entry, for the row-level event the
 * recorder's flush publishes. Null when the agent has no stream rows.
 */
export async function loadLatestTurnEntry(
  db: Queryable,
  agentId: string
): Promise<ChatTurnEntry | null> {
  const [newest] = await listTurnEntries(db, agentId, null, 1);
  return newest?.entry ?? null;
}

/** The chat messages behind chat-sourced prompts, by id. */
async function loadChatMessages(
  db: Queryable,
  ids: string[]
): Promise<Map<string, ChatMessage>> {
  const chat = new Map<string, ChatMessage>();
  // The cast below is the only thing standing between a stored prompt and a
  // permanent 500 on this agent's turns, so ids Postgres would reject are
  // dropped here rather than sent. A dropped id reads as a prompt with no
  // chat text behind it.
  const valid = ids.filter((id) => isChatMessageId(id));
  if (valid.length === 0) return chat;
  const messages = await db.query(
    `SELECT * FROM agent_chat_messages WHERE id = ANY($1::uuid[])`,
    [valid]
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
