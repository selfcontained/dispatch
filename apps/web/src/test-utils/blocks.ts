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
  BlockReaction,
  BlockReviewFinding,
  BlockReviewState,
  BlockReviewVerdict,
  BlockTasksState,
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
  return {
    id: rest.id ?? `blk_${Math.random().toString(36).slice(2, 8)}`,
    streamId,
    author,
    toAgentId: author.kind === "user" ? streamId : null,
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

export function reviewBody(
  verdict: BlockReviewVerdict,
  summary: string,
  findings: BlockReviewFinding[],
  state: BlockReviewState = { findings: {} }
): BlockBody {
  return { kind: "review", data: { verdict, summary, findings }, state };
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
