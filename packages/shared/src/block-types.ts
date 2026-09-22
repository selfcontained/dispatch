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
  "finding",
  "tasks",
  "launch",
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
};

/**
 * A block that shows other blocks inside it lists them here, in order: a
 * launch card the review its agent posted, a review its findings. The
 * listed blocks are rows of their own (their own state, their own thread)
 * stored in the host's thread; the host renders them instead of the thread
 * listing them as replies. Read back resolved as `Block.blocks`.
 */
export type BlockShows = { blocks?: string[] };

/** Who did something to a block, and when. */
export type BlockActor = { by: BlockAuthor; at: string };

/**
 * A question or form pulled back before anyone answered it: closed, but not
 * with an answer. Distinct from `answer`/`submission` so the UI can tell
 * "settled" apart from "withdrawn" and render the block disabled either way.
 */
export type BlockCancellation = BlockActor & {
  /** Short, optional: why it was pulled. */
  reason?: string;
};

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
  cancellation?: BlockCancellation;
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
  cancellation?: BlockCancellation;
};

export type BlockLinkData = { url: string; title?: string };

export type BlockReviewSeverity = "blocker" | "major" | "minor" | "nit";

/**
 * One finding as a reviewer states it. Posted inside a review, it becomes
 * a `finding` block of its own: its record is its state, its discussion is
 * its thread.
 */
export type BlockFindingData = {
  severity: BlockReviewSeverity;
  title: string;
  body: string;
  path?: string;
  line?: number;
};

/** A review as its author posts it: the summary, and the findings. */
export type BlockReviewInput = {
  summary: string;
  findings: BlockFindingData[];
};

/**
 * A review block's own data is its summary. Its findings are blocks it
 * shows (`state.blocks`); where the review stands comes from them.
 */
export type BlockReviewData = { summary: string };

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

/** A review's state: the findings it shows, in the order they were posted. */
export type BlockReviewState = BlockShows;

/** Where a review stands, derived from its findings. */
export type BlockReviewStatus = "open" | "partially_resolved" | "resolved";

/**
 * The wire form of a finding change, as `update`/`PATCH …/state` take it:
 * `{ status }` with a word (`open`, `fixed`, `dismissed`; `resolved` means
 * fixed) or the full record, and an optional note.
 */
export type BlockFindingPatch = {
  status: "open" | "fixed" | "dismissed" | "resolved";
  resolution?: BlockFindingResolution;
  note?: string;
};

/**
 * A review is resolved once every finding is (or it never had any),
 * partially resolved while some are, and open until the first one is.
 * Nothing else says where a review stands: there is no verdict to keep in
 * step with the findings.
 */
export function reviewStatus(
  findings: ReadonlyArray<{ state: BlockFindingState | null } | null>
): BlockReviewStatus {
  const total = findings.length;
  if (total === 0) return "resolved";
  const resolved = findings.filter(
    (finding) => finding?.state?.status === "resolved"
  ).length;
  if (resolved === total) return "resolved";
  return resolved === 0 ? "open" : "partially_resolved";
}

/** A review's findings, as the blocks it shows: whatever is not one is skipped. */
export function reviewFindings(
  review: Pick<Block, "blocks">
): Array<Extract<Block, { kind: "finding" }>> {
  return (review.blocks ?? []).filter(
    (block): block is Extract<Block, { kind: "finding" }> =>
      block.kind === "finding"
  );
}

export type BlockTasksData = { items: Array<{ id: string; text: string }> };
export type BlockTaskStatus = "todo" | "now" | "done";
export type BlockTasksState = { items: Record<string, BlockTaskStatus> };

export type BlockTextData = {
  /** Turn blocks: the `agent_stream_events` row that opened the turn. */
  turnEventId?: number;
  /**
   * A person's post that named its recipients with `@name`: every agent it
   * was delivered to, in order of mention. `toAgentId` is the first.
   */
  mentions?: string[];
  /**
   * A reply delivered to more than one agent without naming them (a
   * person's comment reaches both sides of the thread): every agent it went
   * to. `toAgentId` is the first.
   */
  recipients?: string[];
};

/**
 * A launch block is the agent's card: the one entry for it in the stream
 * and the thread its work goes to by default. `toAgentId` is the agent;
 * who it is (name, engine, model, persona, status) is read from the agent
 * record, so the card follows the agent. The block keeps what only the
 * launch knows: the briefing (its text), the steps that brought the
 * workspace up, and the instructions the agent was started with.
 */
export type BlockLaunchState = BlockShows & {
  startup?: BlockStartup;
  /** The system prompt the agent runs with, rewritten when it changes. */
  instructions?: string;
};

/** `kind` with its `data` and `state`, so a switch on kind types both. */
export type BlockBody =
  | { kind: "text"; data: BlockTextData | null; state: null }
  | { kind: "file"; data: null; state: null }
  | { kind: "link"; data: BlockLinkData; state: null }
  | { kind: "question"; data: BlockQuestionData; state: BlockQuestionState }
  | { kind: "form"; data: BlockFormData; state: BlockFormState }
  | { kind: "review"; data: BlockReviewData; state: BlockReviewState }
  | { kind: "finding"; data: BlockFindingData; state: BlockFindingState }
  | { kind: "tasks"; data: BlockTasksData; state: BlockTasksState }
  | { kind: "launch"; data: null; state: BlockLaunchState | null };

/**
 * `turn`: the agent's answer for one turn, written empty when the turn
 * opens and filled when it settles; the turn itself (steps, timing) rides
 * along as `Block.turn`, read from the agent's event log.
 */
export type BlockOrigin = "turn";

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
 * The launch card's record of an agent starting: the steps so far, and
 * how it ended. Written as the phases happen, so the stream shows the
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
  /**
   * The block whose thread this is in; null for a top-level block. A thread
   * opens on a top-level block or on a block another one shows (a finding
   * in a review), so this is not always a top-level block.
   */
  threadId: string | null;
  /** The block replied to (inside `threadId`); null for a top-level block. */
  replyTo: string | null;
  /** Markdown. May be blank when data or attachments carry the content. */
  text: string;
  attachments: ChatAttachment[];
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
  /**
   * The blocks this one shows (`state.blocks`), resolved and in order, each
   * with its own thread counts and the blocks it shows in turn. Attached at
   * read time.
   */
  blocks?: Block[];
  /** Blocks that open a thread: how many replies it holds. */
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
  /**
   * First page only: every question or form an agent has open for people
   * anywhere in the stream, oldest first — in threads too (a child asks in
   * its own thread, on its launch card), where the feed does not list it.
   */
  openInputs?: Block[];
  /**
   * First page only: the newest posts in threads that carry a link or a pull
   * request, newest first — a child's work lands in its own thread.
   */
  threadLinks?: Block[];
  /**
   * The name of every agent this page's blocks mention, archived agents
   * included: the agents list leaves those out, and their posts keep their
   * names. The live directory is preferred; this is the fallback. Always
   * sent; optional so a cache built on the client need not invent one.
   */
  agentNames?: Record<string, string>;
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
  /** As on the feed: names for every agent the thread mentions. */
  agentNames?: Record<string, string>;
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
  /** Reply in this block's thread (or to a reply inside one). */
  replyTo?: string;
  attachments?: ChatUserAttachmentInput[];
  /**
   * Cut the agent's running turn so this message is what it reads next.
   * Without it a message sent mid-turn waits for the turn to finish.
   */
  interrupt?: boolean;
  /** A review left by hand (the Changes tab): the block becomes a `review`. */
  review?: BlockReviewInput;
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
 * into the block's (a finding's status, a task's status). On a question or
 * form addressed to the user, `{ cancellation: true | "<reason>" | { reason } }`
 * withdraws it instead of merging — see `BlockCancellation`.
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
/** `POST /streams/:rootId/blocks/:blockId/read`: a thread seen. */
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
/** A cancellation's optional reason: short, like an option label with room. */
export const BLOCK_CANCEL_REASON_MAX_CHARS = 500;
export const BLOCK_REVIEW_FINDINGS_MAX = 50;
export const BLOCK_TASKS_MAX = 50;
/** Distinct emoji one block can carry. */
export const BLOCK_REACTIONS_MAX = 20;
