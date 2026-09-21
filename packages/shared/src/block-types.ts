/**
 * Streams and blocks: the wire contract for an agent's stream. See
 * docs/design/blocks.md. A stream belongs to a root agent; a block is one
 * post in it, by an agent or a person, optionally addressed to an agent
 * (which delivers it as a prompt) and optionally replying under another
 * block (a thread). Turns and system status marks interleave with blocks
 * by time but are not blocks; see chat-types.ts for those.
 */

import type {
  ChatAttachment,
  ChatTurnEntry,
  ChatUserAttachmentInput,
} from "./chat-types.js";

export type BlockAuthorKind = "agent" | "user";

export type BlockAuthor = { kind: "user" } | { kind: "agent"; agentId: string };

export const BLOCK_KINDS = [
  "text",
  "question",
  "form",
  "file",
  "link",
  "review",
  "tasks",
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

// ---------------------------------------------------------------------------
// Kind payloads: `data` is what the author posted, `state` is what changed
// since (an answer, a resolution, a tick). Both are null for kinds without.
// ---------------------------------------------------------------------------

export type BlockOption = {
  label: string;
  /** Sent back to the author when chosen. Defaults to the label. */
  value?: string;
};

export type BlockQuestionData = {
  options: BlockOption[];
  /** When true the UI hints that a typed reply is also acceptable. */
  allowFreeform?: boolean;
  /** Asked under a review finding: the discussion it belongs to. */
  findingId?: string;
};

/** Who did something to a block, and when. */
export type BlockActor = { by: BlockAuthor; at: string };

export type BlockQuestionState = {
  answer?: BlockActor & {
    value: string;
    label?: string;
    /**
     * The reply block that carried the answer to the author. Absent when
     * the author closed its own question (nothing to answer any more).
     */
    blockId?: string;
  };
};

export type BlockFormFieldType =
  | "text"
  | "textarea"
  | "number"
  | "select"
  | "checkbox";

export type BlockFormField = {
  id: string;
  label: string;
  type: BlockFormFieldType;
  /** `select` only. */
  options?: BlockOption[];
  required?: boolean;
  placeholder?: string;
  /** Initial value. */
  value?: string | number | boolean;
};

export type BlockFormData = {
  title?: string;
  fields: BlockFormField[];
  submitLabel?: string;
};

export type BlockFormState = {
  submission?: BlockActor & {
    values: Record<string, string | number | boolean>;
    /** The reply block that carried the submission to the author. */
    blockId: string;
  };
};

export type BlockLinkData = { url: string; title?: string };

export type BlockReviewSeverity = "blocker" | "major" | "minor" | "nit";
export type BlockReviewVerdict = "approve" | "request_changes" | "comment";

export type BlockReviewFinding = {
  id: string;
  severity: BlockReviewSeverity;
  title: string;
  body: string;
  path?: string;
  line?: number;
};

export type BlockReviewData = {
  verdict: BlockReviewVerdict;
  summary: string;
  findings: BlockReviewFinding[];
};

export type BlockFindingStatus = "open" | "resolved";
/** How a resolved finding was closed: the change was made, or it was set aside. */
export type BlockFindingResolution = "fixed" | "dismissed";

/**
 * One finding's record: open until someone resolves it as fixed or
 * dismissed, with an optional note saying why; reopening keeps the note
 * given for that. `by`/`at` are whoever last changed it.
 */
export type BlockFindingState = BlockActor & {
  status: BlockFindingStatus;
  resolution?: BlockFindingResolution;
  note?: string;
};

export type BlockReviewState = {
  findings: Record<string, BlockFindingState>;
};

/** Where a review stands, derived from its findings. */
export type BlockReviewStatus = "open" | "partially_resolved" | "resolved";

/**
 * The wire form of a finding change, as `update`/`PATCH …/state` take it:
 * a word (`open`, `fixed`, `dismissed`; `resolved` means fixed) or the
 * full record with a note.
 */
export type BlockFindingPatch =
  | "open"
  | "fixed"
  | "dismissed"
  | "resolved"
  | {
      status: BlockFindingStatus;
      resolution?: BlockFindingResolution;
      note?: string;
    };

/**
 * A review is resolved once every finding is (or it never had any),
 * partially resolved while some are, and open until the first one is.
 */
export function reviewStatus(
  data: Pick<BlockReviewData, "findings">,
  state: BlockReviewState | null | undefined
): BlockReviewStatus {
  const total = data.findings.length;
  if (total === 0) return "resolved";
  const resolved = data.findings.filter(
    (finding) => state?.findings?.[finding.id]?.status === "resolved"
  ).length;
  if (resolved === total) return "resolved";
  return resolved === 0 ? "open" : "partially_resolved";
}

export type BlockTasksData = { items: Array<{ id: string; text: string }> };
export type BlockTaskStatus = "todo" | "now" | "done";
export type BlockTasksState = { items: Record<string, BlockTaskStatus> };

/** `kind` with its `data` and `state`, so a switch on kind types both. */
/**
 * A text reply in a review's thread may be about one finding: the
 * discussion of that item, shown under it rather than in the review's
 * general thread.
 */
export type BlockTextData = {
  findingId?: string;
  /** Workspace blocks (`origin: "workspace"`): the startup's steps. */
  startup?: BlockStartup;
  /** Turn blocks: the `agent_stream_events` row that opened the turn. */
  turnEventId?: number;
  /**
   * A person's post that named its recipients with `@name`: every agent it
   * was delivered to, in order of mention. `toAgentId` is the first.
   */
  mentions?: string[];
};

export type BlockBody =
  | { kind: "text"; data: BlockTextData | null; state: null }
  | { kind: "file"; data: null; state: null }
  | { kind: "link"; data: BlockLinkData; state: null }
  | { kind: "question"; data: BlockQuestionData; state: BlockQuestionState }
  | { kind: "form"; data: BlockFormData; state: BlockFormState }
  | { kind: "review"; data: BlockReviewData; state: BlockReviewState }
  | { kind: "tasks"; data: BlockTasksData; state: BlockTasksState };

/**
 * `launch`: the launch-context post. `turn`: the agent's answer for one
 * turn, written empty when the turn opens and filled when it settles; the
 * turn itself (steps, timing) rides along as `Block.turn`, read from the
 * agent's event log. `system_prompt`: the guidance the agent was started
 * with, kept at the head of the stream so what it was told is readable.
 */
export type BlockOrigin =
  | "launch"
  | "turn"
  | "system_prompt"
  /** The workspace coming up: worktree, config, dependencies, engine. */
  | "workspace";

/** One step of bringing an agent's workspace up. */
export type BlockStartupStep = {
  /** The setup phase this step reports: worktree, env, deps, session. */
  phase: string;
  /** What it is doing, in the present tense: "Installing dependencies". */
  label: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "done" | "failed";
  /** Why it failed, when it did. */
  detail?: string;
};

/**
 * The workspace block's record of an agent starting: the steps so far,
 * and how it ended. Written as the phases happen, so the stream shows the
 * startup as live activity rather than after the fact.
 */
export type BlockStartup = {
  steps: BlockStartupStep[];
  /** When every step finished and the agent was running. */
  readyAt?: string;
  /** Set when startup failed; the message says what went wrong. */
  failed?: string;
  /** The directory the agent works in, once it is known. */
  cwd?: string;
};

export type BlockReaction = {
  id: string;
  author: BlockAuthor;
  emoji: string;
  /**
   * User reactions on an agent's block only: whether delivery to the agent
   * succeeded; `null` while pending. Always `null` on agent reactions.
   */
  delivered: boolean | null;
  createdAt: string;
};

/**
 * Where one recipient's copy of a post has got to.
 *
 * `held` is the state a person most needs to see and the only one that is
 * not stored: the agent is mid-turn, so the prompt waits for it to finish
 * rather than being lost. It is derived whenever the stream is read, so a
 * reload, a second tab and another device all agree on it.
 */
export type BlockDeliveryState = "pending" | "held" | "delivered" | "failed";

export type BlockDelivery = {
  agentId: string;
  state: BlockDeliveryState;
};

export type Block = {
  id: string;
  /** The root agent whose stream this is. */
  streamId: string;
  author: BlockAuthor;
  /**
   * The agent this block is for. A person's message to an agent, and an
   * agent's message to another agent, both set it; it is delivered to that
   * agent as a prompt. Null when the block is for people (an agent's reply,
   * a file it shared, a question it asks the user).
   */
  toAgentId: string | null;
  /** The top-level block this replies under; null for a top-level block. */
  threadId: string | null;
  /** The block replied to (inside `threadId`); null for a top-level block. */
  replyTo: string | null;
  /** Markdown. May be blank when data or attachments carry the content. */
  text: string;
  attachments: ChatAttachment[];
  /** `launch` on the block that records what an agent was started with. */
  origin?: BlockOrigin;
  /** Launch blocks only: the agent that launched this one, when not a person. */
  launchedByAgentId?: string;
  /**
   * Blocks with `toAgentId`: whether the prompt reached every agent it was
   * addressed to. `null` while queued; a `stream.entry` follows once it
   * settles. `delivery` says where each recipient's copy got to.
   */
  delivered: boolean | null;
  /**
   * Where the post has got to, one entry per agent it was addressed to,
   * in the order it named them. Attached at read time, because `held`
   * depends on what the agent is doing right now. Absent on a block that
   * is for people.
   */
  delivery?: BlockDelivery[];
  /** Agent blocks for people: when the user saw it. */
  readAt: string | null;
  /** Reactions on this block, oldest first. Absent when there are none. */
  reactions?: BlockReaction[];
  /** Top-level blocks: how many replies the thread holds. */
  replyCount?: number;
  lastReplyAt?: string | null;
  /** Agent replies the person has not seen yet. */
  unreadReplies?: number;
  /** Who has written in the thread, in order of first appearance. */
  repliers?: BlockAuthor[];
  /**
   * Turn blocks (`origin: "turn"`): the turn as assembled from the agent's
   * event log, attached at read time. Its steps fold under the answer; its
   * `settled` says whether the text is final.
   */
  turn?: ChatTurnEntry;
  createdAt: string;
  updatedAt: string;
} & BlockBody;

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

export type StreamBlockEntry = {
  type: "block";
  id: string;
  at: string;
  block: Block;
};

/** One row of `GET /streams/:rootId/blocks`: a block, a turn, or a system status mark. */
/** The stream is blocks only: everything rendered into it is a block. */
export type StreamEntry = StreamBlockEntry;

export type StreamFeedResponse = {
  entries: StreamEntry[];
  hasMore: boolean;
  /** Opaque cursor for the next (older) page; `null` when `hasMore` is false. */
  nextCursor: string | null;
  unreadCount: number;
};

/**
 * One feed row, exactly as the feed would return it, published when it is
 * written or edited so a mounted feed puts it in place instead of
 * refetching. Blocks, turns and status marks are published this way.
 */
export type StreamEntryEvent = {
  type: "stream.entry";
  agentId: string;
  entry: StreamEntry;
};

/** `GET /streams/:rootId/blocks/:id/thread`. */
export type StreamThreadResponse = {
  root: Block;
  replies: Block[];
};

// ---------------------------------------------------------------------------
// Requests (people; agents go through the `post` / `update` / `react` tools)
// ---------------------------------------------------------------------------

/** Body of `POST /streams/:rootId/blocks`. */
export type StreamPostRequest = {
  /**
   * The block's id, minted by the client (a UUID) so the optimistic row and
   * the stored row are one. Reusing an id is a 409.
   */
  id?: string;
  /** The agent to deliver to; defaults to the stream's root agent. */
  to?: string;
  /** May be blank when at least one attachment is present. */
  text: string;
  /** Reply under this top-level block (or a reply in its thread). */
  replyTo?: string;
  /** With `replyTo` on a review: the finding this reply is about. */
  finding?: string;
  attachments?: ChatUserAttachmentInput[];
  /**
   * Cut the agent's running turn so this message is what it reads next.
   * Without it a message sent mid-turn waits for the turn to finish.
   */
  interrupt?: boolean;
  /** A review left by hand (the Changes tab): the block becomes a `review`. */
  review?: BlockReviewData;
};

/** Body of `POST /streams/:rootId/blocks/:id/answer` (question blocks). */
export type StreamAnswerRequest = {
  id?: string;
  value: string;
  /** Only consulted for a freeform answer; an option's label wins otherwise. */
  label?: string;
  attachments?: ChatUserAttachmentInput[];
};

/** Body of `POST /streams/:rootId/blocks/:id/submit` (form blocks). */
export type StreamSubmitRequest = {
  id?: string;
  values: Record<string, string | number | boolean>;
};

/**
 * Body of `PATCH /streams/:rootId/blocks/:id/state`: a partial state merged
 * into the block's (a finding's status, a task's status).
 */
export type StreamStateRequest = {
  state: Record<string, unknown>;
};

export type StreamPostResponse = {
  block: Block;
  /** Mirrors `block.delivered`: `null` while delivery is still pending. */
  delivered: boolean | null;
  /** True when the delivery is waiting behind the agent's current turn. */
  held: boolean;
};

export type StreamAnswerResponse = {
  /** The question or form, with its state set. */
  block: Block;
  /** The user's reply block that carried the answer. */
  reply: Block;
  delivered: boolean | null;
};

export type StreamReactionRequest = { emoji: string };
export type StreamReactionResponse = {
  blockId: string;
  reactions: BlockReaction[];
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Something in the stream changed that the client cannot place: refetch. */
export type StreamChangedEvent = { type: "stream.changed"; agentId: string };

/** A mark-read landed; see ChatReadEvent for the field meanings. */
/** `POST /streams/:rootId/blocks/:blockId/read`: a thread (or one finding's discussion) seen. */
export type StreamThreadReadRequest = { finding?: string };
export type StreamThreadReadResponse = { ids: string[]; readAt: string | null };

export type StreamReadEvent = {
  type: "stream.read";
  agentId: string;
  unreadCount: number;
  readAt: string;
  upToAt: string | null;
};

export const BLOCK_TEXT_MAX_CHARS = 20_000;
export const BLOCK_ATTACHMENTS_MAX = 20;
export const BLOCK_OPTIONS_MAX = 10;
/**
 * An option is a button: a short action, not the explanation (that goes
 * in the text). Short enough for one line on a phone.
 */
export const BLOCK_OPTION_LABEL_MAX_CHARS = 32;
export const BLOCK_FORM_FIELDS_MAX = 20;
export const BLOCK_REVIEW_FINDINGS_MAX = 50;
export const BLOCK_TASKS_MAX = 50;
/** Distinct emoji one block can carry. */
export const BLOCK_REACTIONS_MAX = 20;
