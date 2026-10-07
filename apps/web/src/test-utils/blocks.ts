/**
 * Block fixtures for the chat tests: a block with sensible defaults, its
 * feed entry, and the kind-specific bodies the tests reach for.
 */
import type {
  Block,
  BlockAuthor,
  BlockBody,
  BlockFormField,
  BlockOption,
  BlockQuestionState,
  BlockFindingData,
  BlockFindingState,
  BlockLaunchState,
  BlockReaction,
  BlockTasksState,
  ChatTurnEntry,
  StreamBlockEntry,
} from "@dispatch/shared";

export const STREAM_ID = "agt_1";

export const TEXT_BODY: BlockBody = { kind: "text", data: null, state: null };

export type BlockOverrides = Partial<
  Omit<Block, "kind" | "data" | "state" | "author">
> & {
  author?: BlockAuthor;
  /** Shorthand for `author`; a user block defaults to `toAgentId` = stream. */
  authorKind?: "user" | "agent";
  /** The kind with its data and state; text when omitted. */
  body?: BlockBody;
};

export function block(overrides: BlockOverrides = {}): Block {
  const {
    author: authorOverride,
    authorKind,
    body = TEXT_BODY,
    ...rest
  } = overrides;
  const streamId = rest.streamId ?? STREAM_ID;
  const author: BlockAuthor =
    authorOverride ??
    (authorKind === "user"
      ? { kind: "user" }
      : { kind: "agent", agentId: streamId });
  const createdAt = rest.createdAt ?? "2026-09-02T10:00:00.000Z";
  const toAgentId =
    rest.toAgentId !== undefined
      ? rest.toAgentId
      : author.kind === "user"
        ? streamId
        : null;
  // The server attaches one delivery entry per recipient at read time, so
  // the fixture does too unless a test states its own.
  const delivered = rest.delivered ?? null;
  const delivery =
    rest.delivery ??
    (toAgentId
      ? [
          {
            agentId: toAgentId,
            state:
              delivered === true
                ? ("delivered" as const)
                : delivered === false
                  ? ("failed" as const)
                  : ("pending" as const),
          },
        ]
      : undefined);
  return {
    id: rest.id ?? `blk_${Math.random().toString(36).slice(2, 8)}`,
    streamId,
    author,
    toAgentId,
    ...(delivery ? { delivery } : {}),
    threadId: null,
    replyTo: null,
    text: "Hello **there**",
    attachments: [],
    delivered: null,
    readAt: null,
    createdAt,
    updatedAt: createdAt,
    ...rest,
    ...body,
  };
}

export function blockEntry(b: Block): StreamBlockEntry {
  return { type: "block", id: b.id, at: b.createdAt, block: b };
}

export function questionBody(
  options: BlockOption[],
  extra: { allowFreeform?: boolean; state?: BlockQuestionState } = {}
): BlockBody {
  return {
    kind: "question",
    data: {
      options,
      ...(extra.allowFreeform !== undefined
        ? { allowFreeform: extra.allowFreeform }
        : {}),
    },
    state: extra.state ?? {},
  };
}

export function answered(
  value: string,
  label?: string,
  blockId = "reply_1"
): BlockQuestionState {
  return {
    answer: {
      value,
      ...(label ? { label } : {}),
      by: { kind: "user" },
      blockId,
      at: "2026-09-02T10:01:00.000Z",
    },
  };
}

export function formBody(
  fields: BlockFormField[],
  extra: {
    title?: string;
    submitLabel?: string;
    submission?: Record<string, string | number | boolean>;
  } = {}
): BlockBody {
  return {
    kind: "form",
    data: {
      fields,
      ...(extra.title ? { title: extra.title } : {}),
      ...(extra.submitLabel ? { submitLabel: extra.submitLabel } : {}),
    },
    state: extra.submission
      ? {
          submission: {
            values: extra.submission,
            by: { kind: "user" },
            blockId: "reply_1",
            at: "2026-09-02T10:01:00.000Z",
          },
        }
      : {},
  };
}

/** A review's body: its summary, showing these finding blocks in order. */
export function reviewBody(
  summary: string,
  findingIds: string[] = []
): BlockBody {
  return { kind: "review", data: { summary }, state: { blocks: findingIds } };
}

export type FindingBlock = Extract<Block, { kind: "finding" }>;
export type ReviewBlock = Extract<Block, { kind: "review" }>;
export type LaunchBlock = Extract<Block, { kind: "launch" }>;

/**
 * A finding's record: open as the reviewer posted it, or fixed/dismissed
 * by the person, with an optional note.
 */
export function findingRecord(
  outcome: "open" | "fixed" | "dismissed" = "open",
  extra: Partial<Pick<BlockFindingState, "note" | "by" | "at">> = {}
): BlockFindingState {
  return {
    status: outcome === "open" ? "open" : "resolved",
    ...(outcome === "open" ? {} : { resolution: outcome }),
    ...(extra.note !== undefined ? { note: extra.note } : {}),
    by:
      extra.by ??
      (outcome === "open"
        ? { kind: "agent", agentId: STREAM_ID }
        : { kind: "user" }),
    at: extra.at ?? "2026-09-02T10:00:30.000Z",
  };
}

/**
 * A finding block as the server writes it: in its review's thread, by the
 * reviewer, its record its state (open, the reviewer's stamp, by default).
 */
export function findingBlock(
  id: string,
  finding: BlockFindingData,
  overrides: Omit<BlockOverrides, "body"> & {
    record?: BlockFindingState;
    reviewId?: string;
  } = {}
): FindingBlock {
  const { record = findingRecord(), reviewId = "rv1", ...rest } = overrides;
  return block({
    id,
    threadId: reviewId,
    replyTo: reviewId,
    text: "",
    ...rest,
    body: { kind: "finding", data: finding, state: record },
  }) as FindingBlock;
}

/**
 * A review with its findings resolved onto it, as a read returns it: the
 * summary, `state.blocks` naming the findings, and `blocks` the findings.
 */
export function reviewBlock(
  overrides: Omit<BlockOverrides, "body"> & {
    summary?: string;
    findings?: Block[];
  } = {}
): ReviewBlock {
  const { summary = "Looks fine.", findings = [], ...rest } = overrides;
  return block({
    id: "rv1",
    text: "",
    ...rest,
    blocks: findings,
    body: reviewBody(
      summary,
      findings.map((f) => f.id)
    ),
  }) as ReviewBlock;
}

/**
 * A launch card: the person (or `launchedByAgentId`) starting `toAgentId`,
 * its text the briefing, its state the startup and instructions and the
 * blocks it shows.
 */
export function launchBlock(
  overrides: Omit<BlockOverrides, "body"> & {
    launchState?: BlockLaunchState | null;
  } = {}
): LaunchBlock {
  const { launchState, ...rest } = overrides;
  const shown = rest.blocks;
  const state: BlockLaunchState | null =
    launchState !== undefined
      ? launchState
      : shown && shown.length > 0
        ? { blocks: shown.map((b) => b.id) }
        : {};
  return block({
    authorKind: "user",
    text: "",
    delivered: true,
    ...rest,
    body: { kind: "launch", data: null, state },
  }) as LaunchBlock;
}

export function tasksBody(
  items: Array<{ id: string; text: string }>,
  state: BlockTasksState = { items: {} }
): BlockBody {
  return { kind: "tasks", data: { items }, state };
}

export function linkBody(url: string, title?: string): BlockBody {
  return {
    kind: "link",
    data: { url, ...(title ? { title } : {}) },
    state: null,
  };
}

export const FILE_BODY: BlockBody = { kind: "file", data: null, state: null };

export function reaction(
  emoji: string,
  delivered: boolean | null,
  authorKind: "user" | "agent" = "user"
): BlockReaction {
  return {
    id: `r-${authorKind}-${emoji}`,
    author:
      authorKind === "user"
        ? { kind: "user" }
        : { kind: "agent", agentId: STREAM_ID },
    emoji,
    delivered,
    createdAt: "2026-09-02T10:01:00.000Z",
  };
}

/**
 * A turn as the feed carries it: the agent's answer block with the turn
 * attached. `text` is the answer (the server writes it when the turn
 * settles); the turn's own `result` mirrors it unless overridden.
 */
export type TurnBlockOverrides = Omit<BlockOverrides, "turn"> & {
  /** Fields of the assembled turn to override; the rest are settled defaults. */
  turn?: Partial<ChatTurnEntry>;
};

export function turnBlock(overrides: TurnBlockOverrides = {}): Block {
  const {
    turn: turnOverrides = {} as Partial<ChatTurnEntry>,
    ...blockOverrides
  } = overrides;
  const at = blockOverrides.createdAt ?? "2026-09-02T10:00:00.000Z";
  const id =
    blockOverrides.id ?? `turn_${Math.random().toString(36).slice(2, 8)}`;
  const author = blockOverrides.author ?? {
    kind: "agent" as const,
    agentId: blockOverrides.streamId ?? STREAM_ID,
  };
  const agentId = author.kind === "agent" ? author.agentId : STREAM_ID;
  const text = blockOverrides.text ?? "Done.";
  const turn: ChatTurnEntry = {
    type: "turn",
    id: `turn:${id}`,
    agentId,
    at,
    updatedAt: turnOverrides.updatedAt ?? at,
    prompt: { source: "chat", text: "go", attachments: [] },
    trace: { startedAt: at, endedAt: at, finalResult: "ok", steps: [] },
    result: { text, streaming: false },
    settled: true,
    interrupted: false,
    ...turnOverrides,
  };
  const b = block({
    ...blockOverrides,
    id,
    author,
    text,
    createdAt: at,
    body: { kind: "text", data: { turnEventId: 1 }, state: null },
  });
  return { ...b, origin: "turn", turn };
}

/** A turn's feed entry; see {@link turnBlock}. */
export function turnEntry(
  overrides: TurnBlockOverrides = {}
): StreamBlockEntry {
  return blockEntry(turnBlock(overrides));
}
