import type {
  Block,
  BlockOption,
  ChatTurnEntry,
  ChatTurnPrompt,
  ChatTurnPlanEntry,
  ChatTurnQuestionRef,
  ChatTurnStep,
} from "@dispatch/shared";

import { isDeliberateCut } from "../agents/acp/stream-recorder.js";
import type { PromptSource } from "../agents/acp/prompt-source.js";
import type {
  AssistantPayload,
  PlanPayload,
  StreamEventRow,
  ThoughtPayload,
  ToolPayload,
  TurnPayload,
} from "../agents/acp/stream-store.js";
import { type BlockRow, isBlockId, type Queryable, toBlock } from "./store.js";

export type TurnSourceRow = Pick<
  StreamEventRow,
  "id" | "seq" | "kind" | "key" | "payload" | "createdAt" | "updatedAt"
>;

/**
 * A question the agent asked mid-turn, as the assembler carries it. Server
 * side only: the wire sends the card as a `chat` entry and gives the turn a
 * `ChatTurnQuestionRef`, whose answered flag is derived from this.
 */
type AssembledQuestion = {
  /** The chat message id; answers post against it. */
  id: string;
  text: string;
  options: BlockOption[];
  allowFreeform: boolean;
  answer: { value: string; label?: string } | null;
  createdAt: string;
};

/**
 * A turn as the assembler shapes it, on the way to the feed entry
 * `toTurnEntry` frames from it. Not a wire type: `toTurnEntry` is its only
 * reader, and it carries each question whole because the entry needs the
 * answer state off it.
 */
export type AssembledTurn = {
  id: string;
  prompt: ChatTurnPrompt;
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
  questions?: AssembledQuestion[];
  /** The task list as the engine last published it during this turn. */
  plan?: ChatTurnPlanEntry[];
  /** Context used and, where the engine reports it, cost so far in this session. */
  usage?: { used: number; size: number; costUsd: number | null };
};

/** The agent's own status reports already show as status lines; in a trace they are noise. */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

function promptFor(
  source: PromptSource,
  chat: Map<string, PromptBlock>
): ChatTurnPrompt {
  if (source.source === "chat") {
    const block = chat.get(source.chatMessageId);
    // Posts delivered together: the turn's prompt reads as all of them, in
    // order, under the first one's sender and place.
    const combinedText =
      source.chatMessageIds && source.chatMessageIds.length > 1
        ? source.chatMessageIds
            .map((id) => chat.get(id)?.text ?? "")
            .filter((t) => t.length > 0)
            .join("\n\n")
        : null;
    if (block?.author.kind === "agent") {
      // Another agent's post, delivered as this turn's prompt.
      return {
        source: "agent",
        text: combinedText ?? block.text,
        chatMessageId: source.chatMessageId,
        senderName: block.authorName ?? block.author.agentId,
        senderAgentId: block.author.agentId,
        ...(block.threadId ? { threadId: block.threadId } : {}),
        attachments: block.attachments,
      };
    }
    return {
      source: block?.origin === "launch" ? "launch" : "chat",
      text: combinedText ?? block?.text ?? "",
      chatMessageId: source.chatMessageId,
      ...(block?.threadId ? { threadId: block.threadId } : {}),
      ...(block && block.kind !== "text" ? { kind: block.kind } : {}),
      ...(block?.launchedByAgentId
        ? { launchedByAgentId: block.launchedByAgentId }
        : {}),
      attachments: block?.attachments ?? [],
    };
  }
  if (source.source === "agent") {
    return {
      source: "agent",
      text: source.text,
      senderName: source.senderName,
      senderAgentId: source.senderId,
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
function locationsFromInput(
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

function toolStep(row: TurnSourceRow): ChatTurnStep | null {
  const p = row.payload as Partial<ToolPayload>;
  const title = p.title ?? "";
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
          // the model spent thinking; the step list shows it like any step.
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
function toQuestion(block: Block): AssembledQuestion {
  const question = block.kind === "question" ? block : null;
  const answer = question?.state?.answer ?? null;
  return {
    id: block.id,
    text: block.text,
    options: question?.data.options ?? [],
    allowFreeform: question?.data.allowFreeform === true,
    answer: answer
      ? {
          value: answer.value,
          ...(answer.label ? { label: answer.label } : {}),
        }
      : null,
    createdAt: block.createdAt,
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
/** A block behind a prompt, with its agent author's name when it has one. */
export type PromptBlock = Block & { authorName?: string };

export function assembleTurns(
  rows: TurnSourceRow[],
  chat: Map<string, PromptBlock>,
  questions: Block[] = []
): AssembledTurn[] {
  const groups = groupTurnRows(rows);
  // Each question belongs to the latest turn that had started when it was
  // posted; one posted before any turn goes with the first.
  const starts = groups.map((g) => (g.turn ?? g.rows[0]).createdAt.getTime());
  const byGroup = new Map<number, AssembledQuestion[]>();
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
    // In a turn still running, a thought that is the newest row is the one
    // being written now: it reads as a running step, not a finished one.
    const live = group.turn !== null && !settled;
    const newest = group.rows[group.rows.length - 1];
    // Everything the engine says is the answer, in the order it said it:
    // text written between tool calls stays where the reader first saw it
    // and later text is appended under it. Moving earlier text into the
    // step list once a tool call followed made it vanish mid-read, and the
    // closing text ("as above") then referred to something no longer shown.
    const spoken: string[] = [];
    let truncated = false;
    const flat: {
      step: ChatTurnStep;
      key: string | null;
      parent: string | null;
    }[] = [];
    let plan: ChatTurnPlanEntry[] | undefined;
    for (const row of group.rows) {
      if (row.kind === "tool_call") {
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
        const p = row.payload as Partial<AssistantPayload>;
        const text = p.text ?? "";
        if (text.trim()) spoken.push(text.trim());
        if (p.truncated) truncated = true;
        result = {
          text: spoken.join("\n\n"),
          streaming: row === newest && p.streaming === true && !settled,
          ...(truncated ? { truncated: true } : {}),
        };
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
  // A turn the service went down under, or one Dispatch stopped on purpose
  // (stop, archive), settles carrying a marker as its error. That is a cut,
  // not a failure the engine reported, so the entry says `interrupted` and
  // drops the marker rather than showing it as an error line under the result.
  const cut = isDeliberateCut(payload?.error);
  const trace: ChatTurnEntry["trace"] = cut
    ? { ...turn.trace, finalResult: "interrupted" }
    : turn.trace;
  const error = cut ? undefined : turn.error;
  // A closed retry is history: the conversation moved past the failure.
  const retry =
    error && (payload?.retry === "open" || payload?.retry === "retried")
      ? payload.retry
      : undefined;
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
    ...(retry ? { retry } : {}),
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
};

/**
 * The turns anchored at the given `turn` rows of one agent, assembled from
 * the rows between each anchor and the next turn row. Keyed by anchor id;
 * an id that names no turn row of the agent's is simply absent.
 */
export async function loadTurnEntries(
  db: Queryable,
  agentId: string,
  anchorIds: readonly number[]
): Promise<Map<number, ChatTurnEntry>> {
  const out = new Map<number, ChatTurnEntry>();
  if (anchorIds.length === 0) return out;
  const anchors = await db.query<{ id: number | string; seq: number }>(
    `SELECT id, seq
       FROM agent_stream_events
      WHERE agent_id = $1 AND kind = 'turn' AND id = ANY($2::bigint[])`,
    [agentId, anchorIds]
  );
  if (anchors.rows.length === 0) return out;
  const wanted = new Set(anchors.rows.map((r) => Number(r.id)));
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
    `SELECT id, seq, kind, key, payload, created_at, updated_at
       FROM agent_stream_events
      WHERE agent_id = $1 AND seq >= $2
        AND ($3::int IS NULL OR seq < $3)
      ORDER BY seq ASC`,
    [agentId, fromSeq, untilSeq]
  );
  const source: TurnSourceRow[] = rows.rows.map((r) => ({
    id: Number(r.id),
    seq: r.seq,
    kind: r.kind,
    key: r.key,
    payload: r.payload,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  const chat = await loadChatMessages(db, agentId, chatPromptIds(source));
  // Questions the agent asked while these turns ran. Bounded above as well
  // as below: a question from a newer turn would otherwise attach to the
  // last turn here, which is the one that had started when it landed.
  const since = source.length ? source[0].createdAt : new Date(0);
  const asked = await db.query(
    `SELECT * FROM blocks
      WHERE author_kind = 'agent' AND author_agent_id = $1
        AND kind = 'question' AND to_agent_id IS NULL AND thread_id IS NULL
        AND created_at >= $2
        AND ($3::timestamptz IS NULL OR created_at < $3)
      ORDER BY created_at ASC`,
    [agentId, since, untilAt]
  );
  const questions = asked.rows.map((row) => toBlock(row as never));
  const groups = groupTurnRows(source);
  const turns = assembleTurns(source, chat, questions);
  turns.forEach((turn, index) => {
    const group = groups[index];
    if (!group?.turn || !wanted.has(group.turn.id)) return;
    out.set(group.turn.id, toTurnEntry(turn, group, agentId));
  });
  return out;
}

/** A turn block's anchor: the `turn` row it was opened for. */
export function turnAnchorOf(block: Block): number | null {
  if (block.origin !== "turn" || block.kind !== "text") return null;
  const id = block.data?.turnEventId;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

/**
 * Give every turn block among `blocks` its turn, assembled from its agent's
 * event log. Mutates and returns the same array; blocks of other kinds pass
 * through untouched.
 */
export async function attachTurns<T extends Block>(
  db: Queryable,
  blocks: T[]
): Promise<T[]> {
  const byAgent = new Map<string, number[]>();
  for (const block of blocks) {
    const anchor = turnAnchorOf(block);
    if (anchor === null || block.author.kind !== "agent") continue;
    const list = byAgent.get(block.author.agentId) ?? [];
    list.push(anchor);
    byAgent.set(block.author.agentId, list);
  }
  const loaded = new Map<string, Map<number, ChatTurnEntry>>();
  await Promise.all(
    [...byAgent].map(async ([agentId, anchors]) => {
      loaded.set(agentId, await loadTurnEntries(db, agentId, anchors));
    })
  );
  for (const block of blocks) {
    const anchor = turnAnchorOf(block);
    if (anchor === null || block.author.kind !== "agent") continue;
    const turn = loaded.get(block.author.agentId)?.get(anchor);
    if (turn) block.turn = turn;
  }
  return blocks;
}

/**
 * The block behind the agent's newest turn, for the row-level event the
 * recorder's flush publishes. Null when the agent has no turn with a block.
 */
export async function loadNewestTurnBlockId(
  db: Queryable,
  agentId: string
): Promise<string | null> {
  const result = await db.query<{ block_id: string | null }>(
    `SELECT payload->>'blockId' AS block_id
       FROM agent_stream_events
      WHERE agent_id = $1 AND kind = 'turn'
      ORDER BY seq DESC
      LIMIT 1`,
    [agentId]
  );
  return result.rows[0]?.block_id ?? null;
}

/** The chat message ids the page's turn rows name as their prompt. */
function chatPromptIds(rows: TurnSourceRow[]): string[] {
  return rows
    .filter((r) => r.kind === "turn")
    .map((r) => (r.payload as TurnPayload).prompt)
    .filter(
      (p): p is Extract<PromptSource, { source: "chat" }> => p.source === "chat"
    )
    .flatMap((p) => p.chatMessageIds ?? [p.chatMessageId]);
}

/**
 * The blocks behind chat-sourced prompts, by id. Scoped to the agent: a
 * prompt's block id is parsed out of text that can embed another agent's
 * post or a review body verbatim, so only a block delivered to this agent
 * (or on its stream) counts; anything else reads as a prompt with no block
 * behind it.
 */
async function loadChatMessages(
  db: Queryable,
  agentId: string,
  ids: string[]
): Promise<Map<string, PromptBlock>> {
  const chat = new Map<string, PromptBlock>();
  // The cast below is the only thing standing between a stored prompt and a
  // permanent 500 on this agent's turns, so ids Postgres would reject are
  // dropped here rather than sent. A dropped id reads as a prompt with no
  // chat text behind it.
  const valid = ids.filter((id) => isBlockId(id));
  if (valid.length === 0) return chat;
  const blocks = await db.query<BlockRow & { author_name: string | null }>(
    `SELECT b.*, a.name AS author_name
       FROM blocks b
       LEFT JOIN agents a ON a.id = b.author_agent_id
      WHERE b.id = ANY($2::uuid[])
        AND (b.to_agent_id = $1 OR b.stream_id = $1 OR b.author_agent_id = $1)`,
    [agentId, valid]
  );
  for (const row of blocks.rows) {
    const block: PromptBlock = toBlock(row);
    if (row.author_name) block.authorName = row.author_name;
    chat.set(block.id, block);
  }
  return chat;
}
