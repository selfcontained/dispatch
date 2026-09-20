import { memo, type ReactNode, useMemo } from "react";
import type { Block, BlockOption, ChatStatusEntry } from "@dispatch/shared";
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  Copy,
  Hourglass,
  Loader2,
  MessagesSquare,
  Rocket,
  UserRound,
  MessageSquare,
} from "lucide-react";

import {
  latestEventColor,
  latestEventLabel,
} from "@/components/app/agent-event-utils";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { useCopyText } from "@/hooks/use-copy";
import { type AgentRelation, agentRelation } from "@/lib/agent-lineage";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { useThread } from "@/hooks/use-stream";
import { cn } from "@/lib/utils";

import {
  type BlockStatePatch,
  FormBlockBody,
  LinkBlockBody,
  QuestionOptions,
  ReviewBlockBody,
  TasksBlockBody,
} from "./block-bodies";
import { AttachmentList } from "./chat-attachment-views";
import {
  POST_ACTION_BUTTON,
  POST_ACTION_FACE,
  ReactionBar,
  ReactionPickerButton,
} from "./chat-reactions";

type EventType = Parameters<typeof latestEventLabel>[0];

const EVENT_TYPES: readonly string[] = [
  "working",
  "blocked",
  "waiting_user",
  "done",
  "idle",
];

function asEventType(type: string): EventType {
  return (EVENT_TYPES.includes(type) ? type : "idle") as EventType;
}

/** "10:04 AM" — the wall-clock time a channel shows next to a post. */
function clockTime(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "";
  return time.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The gutter is 32px wide: "6:47", no meridiem, like Slack's hover time. */
function gutterTime(iso: string): string {
  return clockTime(iso).replace(/\s?[AP]M$/i, "");
}

// ---------------------------------------------------------------------------
// Authors and the post layout
// ---------------------------------------------------------------------------

/** What a peer's post shows of the agent behind it: its icon and its lineage. */
export type PeerInfo = {
  name: string;
  agentType: string | null;
  relation: AgentRelation;
};

/** Peers by id, from this agent's point of view. */
export type PeerDirectory = Readonly<Record<string, PeerInfo>>;

/**
 * Every other agent in the list, as this agent's feed sees it. A plain
 * record (not a Map) so React Query's structural sharing keeps its identity
 * across agent updates that change nothing here.
 */
export function peerDirectory(
  agentId: string,
  agents: readonly Pick<Agent, "id" | "name" | "type" | "parentAgentId">[]
): PeerDirectory {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const peers: Record<string, PeerInfo> = {};
  for (const agent of agents) {
    if (agent.id === agentId) continue;
    peers[agent.id] = {
      name: agent.name,
      agentType: agent.type ?? null,
      relation: agentRelation(agentId, agent.id, byId),
    };
  }
  return peers;
}

/**
 * What every row of the channel needs to know about the agent it belongs
 * to. Every row is memoised on this object's identity, so it carries only
 * what changes rarely.
 */
export type FeedContext = {
  agentId: string;
  /** The stream the feed reads: the root of the agent's lineage. */
  rootId?: string | null;
  /** The agent this channel belongs to; names its posts. */
  agentName?: string;
  agentType?: string | null;
  /** Other agents, for a peer post's avatar and relation; absent until loaded. */
  peers?: PeerDirectory;
  onOpenMedia: (mediaId: number) => void;
  /** Opens the Changes tab on a file, at a line when one is given. */
  onOpenPath?: (path: string, line: number | null) => void;
  /**
   * Adds (`remove: false`) or takes back an emoji reaction on an agent's
   * block. Absent, the feed shows reactions but offers no way to change
   * them.
   */
  onToggleReaction?: (blockId: string, emoji: string, remove: boolean) => void;
  /** Opens a block's thread in the side panel, on one finding when given. */
  onOpenThread?: (blockId: string, findingId?: string) => void;
  /** Submits a form block's values. */
  onSubmitForm?: (
    blockId: string,
    values: Record<string, string | number | boolean>
  ) => void;
  /** `PATCH …/state`: resolve, dispute or reopen a finding. */
  onSetBlockState?: (blockId: string, patch: BlockStatePatch) => void;
};

export type PostAuthor = {
  /** Consecutive posts with the same key can collapse under one header. */
  key: string;
  name: string;
  kind: "user" | "agent" | "peer";
  agentType?: string | null;
  /** Peers only: how the sender stands to this agent. */
  relation?: AgentRelation;
};

function userAuthor(): PostAuthor {
  return { key: "user", name: "You", kind: "user" };
}

export function agentAuthor(ctx: FeedContext, fallback = ""): PostAuthor {
  return {
    key: "agent",
    name: ctx.agentName ?? fallback,
    kind: "agent",
    agentType: ctx.agentType ?? null,
  };
}

/**
 * A sender that is not this agent: its own icon and its place in the
 * lineage when the list knows it, a generic agent otherwise (archived, or
 * from another repository).
 */
export function peerAuthor(
  agentId: string,
  name: string,
  ctx: FeedContext
): PostAuthor {
  const peer = ctx.peers?.[agentId];
  return {
    key: `peer:${agentId}`,
    name,
    kind: "peer",
    agentType: peer?.agentType ?? null,
    relation: peer?.relation ?? "agent",
  };
}

/**
 * Who a block reads as. A launch-context post made by another agent
 * (launch_agent) is that agent's, named from the agents list when it is
 * still there and "Agent" otherwise; every other user block is "You". An
 * agent block is this agent's, or a peer's when another agent wrote into
 * this stream.
 */
export function blockAuthor(block: Block, ctx: FeedContext): PostAuthor {
  if (block.author.kind === "agent") {
    if (block.author.agentId === ctx.agentId) return agentAuthor(ctx, "Agent");
    const peer = ctx.peers?.[block.author.agentId];
    return peerAuthor(block.author.agentId, peer?.name ?? "Agent", ctx);
  }
  if (block.launchedByAgentId) {
    const peer = ctx.peers?.[block.launchedByAgentId];
    return peerAuthor(block.launchedByAgentId, peer?.name ?? "Agent", ctx);
  }
  return userAuthor();
}

/** An agent's name as this feed knows it: the page's agent, a peer, or "Agent". */
export function agentDisplayName(agentId: string, ctx: FeedContext): string {
  if (agentId === ctx.agentId) return ctx.agentName || "Agent";
  return ctx.peers?.[agentId]?.name ?? "Agent";
}

/**
 * An agent's block addressed to another agent is a side conversation the
 * user is overhearing: its header reads "sender → recipient". A person's
 * block, and an agent's block for people, have no other side.
 */
export function blockSide(
  block: Block,
  ctx: FeedContext
): { recipientName: string } | undefined {
  if (block.author.kind !== "agent" || block.toAgentId === null) {
    return undefined;
  }
  return { recipientName: agentDisplayName(block.toAgentId, ctx) };
}

const AVATAR_ICON = "[&>svg]:h-[18px] [&>svg]:w-[18px]";

/**
 * The author's avatar. In a side conversation (`side`) it carries a small
 * arrows badge in its top-right corner, so an agent-to-agent post is told
 * apart from the same agent's posts to the user at a glance.
 */
function Avatar({
  author,
  side = false,
}: {
  author: PostAuthor;
  side?: boolean;
}): JSX.Element {
  const icon =
    author.kind === "user" ? (
      <span
        className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-foreground/[0.08] text-foreground"
        aria-label="You"
        title="You"
        data-testid="chat-avatar-user"
      >
        <UserRound className="h-4 w-4" aria-hidden="true" />
      </span>
    ) : (
      <AgentTypeIcon
        type={author.agentType}
        className={cn("h-8 w-8 rounded-md", AVATAR_ICON)}
      />
    );
  if (!side) return icon;
  return (
    <span className="relative inline-flex" data-testid="chat-avatar-side">
      {icon}
      <span
        className="absolute -right-1 -top-1 flex h-3 w-3 items-center justify-center rounded-full border border-border bg-background text-muted-foreground"
        aria-hidden="true"
        data-testid="chat-avatar-side-badge"
      >
        <ArrowLeftRight className="h-2 w-2" />
      </span>
    </span>
  );
}

/**
 * Who a post reads as, at a glance: "You" and other agents get a faint
 * full-width tint so their posts stand apart from this agent's prose, which
 * stays plain. The tint runs the whole author group, so a run of posts
 * reads as one block.
 */
export const POST_TINT: Record<PostAuthor["kind"], string> = {
  // Only the user's own posts get a fill. At 6% `primary` sat too close to the
  // page background in several themes to notice; 10% reads everywhere.
  //
  // No left accent bar: a rule down the post's left edge competed with the
  // connected-agent border the sidebar draws on the pane's left edge.
  user: "bg-primary/[0.10] hover:bg-primary/[0.14]",
  // Agent-to-agent traffic is a side conversation the user is overhearing, so
  // it recedes — indent and muted body carry it, with no fill of its own.
  peer: "hover:bg-muted/30",
  agent: "hover:bg-muted/40",
};

/**
 * Post bodies stop growing at a comfortable reading measure; on a wide pane
 * a paragraph must not run edge to edge. The tint and the header still span
 * the full width.
 */
export const POST_BODY_MEASURE = "max-w-[90ch]";

/**
 * A side conversation's indent: one gutter step (the 32px avatar column
 * plus its gap) on top of the row's own padding, so the avatar column
 * shifts in and the body narrows by the same amount.
 */
// One gutter step on wide screens; a phone has no room to give up.
export const SIDE_POST_INDENT = "pl-4 sm:pl-[3.75rem]";

/** Opens the post's thread with the composer ready: a person replying to one post. */
export function ReplyInThreadButton({
  onClick,
}: {
  onClick: () => void;
}): JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={POST_ACTION_BUTTON}
      onClick={onClick}
      title="Reply in thread"
      aria-label="Reply in thread"
      data-testid="chat-reply-in-thread"
    >
      <span className={POST_ACTION_FACE}>
        <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </Button>
  );
}

/** A post-local clipboard action with the same confirmation used elsewhere. */
export function MessageCopyButton({ text }: { text: string }): JSX.Element {
  const [copied, copyText] = useCopyText();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        POST_ACTION_BUTTON,
        copied && "opacity-100 text-status-working"
      )}
      onClick={() => copyText(text)}
      title={copied ? "Copied" : "Copy message"}
      aria-label={copied ? "Message copied" : "Copy message"}
      data-testid="chat-copy-message"
    >
      <span className={POST_ACTION_FACE}>
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </span>
    </Button>
  );
}

/**
 * One full-width row of the channel. A header row carries the avatar, the
 * author and the time; a grouped row (same author, shortly after) keeps only
 * the body, and shows the time in the gutter on hover.
 *
 * Rhythm: a group start sits further below the post above it than grouped
 * rows sit below each other, and draws a hairline when it follows another
 * post directly (`rule`), so the boundary between authors is visible even
 * between two long markdown bodies.
 *
 * `side` marks a post that is not addressed to the user — one agent talking
 * to another. It reads as an aside: indented a gutter step, tinted like a
 * peer's post whoever sent it, its body muted, its header "sender →
 * recipient" and its avatar badged with arrows.
 */
export function Post({
  author,
  at,
  grouped,
  rule = false,
  side,
  action,
  flush = false,
  children,
  ...rest
}: {
  author: PostAuthor;
  at: string;
  grouped: boolean;
  /** Draw a hairline above: this group starts right after another post. */
  rule?: boolean;
  /** Who the post is addressed to, when that is another agent. */
  side?: { recipientName: string };
  /** A compact post action, shown in the top-right on hover or touch. */
  action?: ReactNode;
  /**
   * No avatar gutter and a narrower inset: for a card that is the whole
   * subject of a narrow panel (a review in the drawer) and wants the width.
   */
  flush?: boolean;
  children: ReactNode;
  [dataAttr: `data-${string}`]: string | undefined;
}): JSX.Element {
  return (
    <div
      className={cn(
        "group relative flex min-w-0 max-w-full gap-3 transition-colors",
        flush ? "px-3" : side ? cn(SIDE_POST_INDENT, "pr-4") : "px-4",
        side ? POST_TINT.peer : POST_TINT[author.kind],
        grouped ? "py-1" : "mt-3 pb-1.5 pt-2",
        rule && "border-t border-border/40"
      )}
      data-grouped={grouped ? "true" : undefined}
      data-group-start={grouped ? undefined : "true"}
      data-author-kind={author.kind}
      data-rule={rule ? "true" : undefined}
      data-side={side ? "true" : undefined}
      data-flush={flush ? "true" : undefined}
      {...rest}
    >
      {flush ? null : (
        <div className="flex w-8 shrink-0 justify-end">
          {grouped ? (
            <span
              className="invisible whitespace-nowrap pt-1 text-[10px] leading-none text-muted-foreground group-hover:visible"
              title={formatDateTime(at)}
              data-testid="chat-gutter-time"
            >
              {gutterTime(at)}
            </span>
          ) : (
            <Avatar author={author} side={side !== undefined} />
          )}
        </div>
      )}
      <div className="min-w-0 flex-1 after:block after:clear-both after:content-['']">
        {/* Floated beside the body, except in a flush post: there a card
            with its own overflow context would shrink to dodge the float,
            so the action sits in the header row instead. */}
        {action && !flush ? (
          <div
            className="float-right ml-2 max-sm:-mr-2 max-sm:-mt-2 [@media(pointer:coarse)]:-mr-2 [@media(pointer:coarse)]:-mt-2"
            data-testid="chat-post-action"
          >
            {action}
          </div>
        ) : null}
        {grouped ? null : (
          <div
            // Wrapping keeps the recipient readable on narrow screens: rather
            // than squeezing "→ recipient" to nothing beside a long sender,
            // it drops to its own line.
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 leading-tight"
            {...(side
              ? {
                  "aria-label": `${author.name} → ${side.recipientName}`,
                  "data-testid": "chat-side-header",
                }
              : {})}
          >
            <span
              className="max-w-full truncate text-sm font-semibold text-foreground"
              data-testid="chat-post-author"
            >
              {author.name}
            </span>
            {side ? (
              <span
                className="min-w-[8rem] max-w-full truncate text-sm text-muted-foreground"
                data-testid="chat-side-recipient"
              >
                <span aria-hidden="true">→ </span>
                {side.recipientName}
              </span>
            ) : null}
            <span
              className="shrink-0 text-[11px] text-muted-foreground"
              title={formatDateTime(at)}
            >
              {clockTime(at)}
            </span>
            {action && flush ? (
              <div className="ml-auto -my-1" data-testid="chat-post-action">
                {action}
              </div>
            ) : null}
          </div>
        )}
        <div
          className={cn(
            "min-w-0 max-w-full text-sm",
            side ? "text-muted-foreground" : "text-foreground",
            POST_BODY_MEASURE
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** "Today", "Yesterday", or the date, for the rule between days. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "";
  const startOf = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const diff = Math.round((startOf(now) - startOf(time)) / dayMs);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return time.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(time.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function DayDivider({ label }: { label: string }): JSX.Element {
  return (
    <div
      className="my-2 flex items-center gap-3 px-4"
      data-testid="chat-day-divider"
      role="separator"
      aria-label={label}
    >
      <div className="h-px flex-1 bg-border/70" />
      <span className="rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      <div className="h-px flex-1 bg-border/70" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * Delivery state of a block addressed to an agent (a person's, or another
 * agent's); nothing once it has landed, and nothing on a block for people.
 */
function DeliveryMeta({
  block,
  held,
}: {
  block: Block;
  held: boolean;
}): JSX.Element | null {
  if (block.toAgentId === null) return null;
  if (held && block.author.kind === "user") {
    return (
      <div
        className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground"
        title="Waiting for the agent's running turn to finish."
        data-testid="chat-held-hint"
      >
        <Hourglass className="h-3 w-3" />
        Waiting to deliver
      </div>
    );
  }
  if (block.delivered === false) {
    return (
      <div
        className="mt-1 inline-flex items-center gap-1 text-[11px] text-destructive"
        title="The agent had no session to receive this message."
        data-testid="chat-delivery-failed"
      >
        <AlertTriangle className="h-3 w-3" />
        Not delivered
      </div>
    );
  }
  if (block.delivered === null) {
    return (
      <div
        className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground"
        title="Delivering to the agent."
        data-testid="chat-delivery-pending"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Sending
      </div>
    );
  }
  return null;
}

/** "3 replies · last 2m ago", the line that opens a block's thread. */
export function replyLine(block: Block): string | null {
  const count = block.replyCount ?? 0;
  if (count === 0) return null;
  const head = `${count} ${count === 1 ? "reply" : "replies"}`;
  const last = block.lastReplyAt ? formatRelativeTime(block.lastReplyAt) : "";
  return last ? `${head} · last ${last}` : head;
}

function ThreadLine({
  block,
  onOpen,
}: {
  block: Block;
  onOpen?: (blockId: string) => void;
}): JSX.Element | null {
  const label = replyLine(block);
  if (!label) return null;
  return (
    <button
      type="button"
      className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-medium text-status-done underline-offset-2 hover:underline disabled:cursor-default disabled:no-underline"
      disabled={!onOpen}
      data-testid="chat-thread-line"
      data-reply-count={String(block.replyCount ?? 0)}
      onClick={() => onOpen?.(block.id)}
    >
      <MessagesSquare className="h-3 w-3" aria-hidden="true" />
      {label}
    </button>
  );
}

/**
 * A block's body by kind, under its text. `text` and `file` have nothing
 * past the text and the attachments; every other kind hangs its own view.
 */
function BlockBody({
  block,
  ctx,
  answering,
  answersDisabled,
  submitting,
  onAnswer,
  inThread,
  highlightFindingId,
}: {
  block: Block;
  ctx: FeedContext;
  answering: boolean;
  answersDisabled: boolean;
  submitting: boolean;
  onAnswer: (blockId: string, option: BlockOption) => void;
  inThread: boolean;
  highlightFindingId: string | null;
}): JSX.Element | null {
  const { onSubmitForm, onSetBlockState, onOpenThread, onOpenPath } = ctx;
  const setState = onSetBlockState
    ? (patch: BlockStatePatch) => onSetBlockState(block.id, patch)
    : undefined;
  switch (block.kind) {
    case "question":
      return (
        <QuestionOptions
          block={block}
          answering={answering}
          answersDisabled={answersDisabled}
          onAnswer={(option) => onAnswer(block.id, option)}
        />
      );
    case "form":
      return (
        <FormBlockBody
          block={block}
          submitting={submitting}
          disabled={answersDisabled || !onSubmitForm}
          onSubmit={(values) => onSubmitForm?.(block.id, values)}
        />
      );
    case "review":
      return (
        <ReviewBlockWithCounts
          block={block}
          rootId={ctx.rootId ?? null}
          inThread={inThread}
          disabled={answersDisabled}
          onSetState={setState}
          onOpenFinding={
            onOpenThread
              ? (findingId) => onOpenThread(block.id, findingId)
              : undefined
          }
          onOpenPath={onOpenPath}
          // In the stream the card is a summary that opens the review in
          // the drawer; in the drawer it is the whole subject, open.
          compact={!inThread}
          onOpen={onOpenThread ? () => onOpenThread(block.id) : undefined}
          defaultExpanded={inThread}
          highlightFindingId={highlightFindingId}
        />
      );
    case "tasks":
      return <TasksBlockBody block={block} />;
    case "link":
      return <LinkBlockBody block={block} />;
    case "text":
    case "file":
      return null;
  }
}

export type BlockViewProps = {
  block: Block;
  held: boolean;
  grouped: boolean;
  rule?: boolean;
  ctx: FeedContext;
  /** This question's answer is in flight. */
  answering: boolean;
  /** This form's submission is in flight. */
  submitting?: boolean;
  /** Answers go through the same delivery as the composer; lock them together. */
  answersDisabled?: boolean;
  onAnswer: (blockId: string, option: BlockOption) => void;
  /** Inside the thread panel: no reply line, no thread to open. */
  inThread?: boolean;
  /** A review's finding to pick out (the panel's `?finding=`). */
  highlightFindingId?: string | null;
};

/**
 * One block as a post: the author header, the text, the kind's own body,
 * the attachments, and then the delivery state (a person's block), the
 * reactions, and the thread's reply line.
 */
/** How many replies in a review's thread are about each finding. */
export function commentCountsOf(
  replies: readonly Block[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const reply of replies) {
    const findingId =
      reply.kind === "text" && reply.data ? reply.data.findingId : undefined;
    if (findingId) counts[findingId] = (counts[findingId] ?? 0) + 1;
  }
  return counts;
}

/**
 * Agent comments the person has not seen, by finding id. Comments on the
 * review as a whole (no finding) count under `""`.
 */
export function unreadCommentsOf(
  replies: readonly Block[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const reply of replies) {
    if (reply.author.kind !== "agent" || reply.readAt !== null) continue;
    const findingId =
      (reply.kind === "text" && reply.data
        ? reply.data.findingId
        : undefined) ?? "";
    counts[findingId] = (counts[findingId] ?? 0) + 1;
  }
  return counts;
}

/**
 * The review card with each finding's comment count and the comments not
 * yet seen, read from the review's thread once it has replies.
 */
function ReviewBlockWithCounts({
  rootId,
  inThread,
  ...props
}: Omit<
  Parameters<typeof ReviewBlockBody>[0],
  "commentCounts" | "unreadCounts"
> & {
  rootId: string | null;
  /** Already on the review's page: its thread is loaded whatever the count says. */
  inThread: boolean;
}): JSX.Element {
  const thread = useThread(
    rootId,
    inThread || (props.block.replyCount ?? 0) > 0 ? props.block.id : null
  );
  const commentCounts = useMemo(
    () => commentCountsOf(thread.replies),
    [thread.replies]
  );
  const unreadCounts = useMemo(
    () => unreadCommentsOf(thread.replies),
    [thread.replies]
  );
  return (
    <ReviewBlockBody
      {...props}
      commentCounts={commentCounts}
      unreadCounts={unreadCounts}
    />
  );
}

export const BlockView = memo(function BlockView({
  block,
  held,
  grouped,
  rule = false,
  ctx,
  answering,
  submitting = false,
  answersDisabled = false,
  onAnswer,
  inThread = false,
  highlightFindingId = null,
}: BlockViewProps): JSX.Element {
  const author = blockAuthor(block, ctx);
  // Inside the panel the thread itself says who is talking to whom; the
  // side indent would only push the replies off the left edge.
  const side = inThread ? undefined : blockSide(block, ctx);
  const replyAction =
    !inThread && ctx.onOpenThread ? (
      <ReplyInThreadButton onClick={() => ctx.onOpenThread?.(block.id)} />
    ) : null;
  const copyAction =
    block.text || replyAction ? (
      <div className="flex items-center">
        {replyAction}
        {block.text ? <MessageCopyButton text={block.text} /> : null}
      </div>
    ) : undefined;
  const reactions = block.reactions ?? [];
  const threadLine = inThread ? null : (
    <ThreadLine block={block} onOpen={ctx.onOpenThread} />
  );
  const body = (
    <BlockBody
      block={block}
      ctx={ctx}
      answering={answering}
      answersDisabled={answersDisabled}
      submitting={submitting}
      onAnswer={onAnswer}
      inThread={inThread}
      highlightFindingId={highlightFindingId}
    />
  );

  // A person's block, whoever it reads as: a launch-context post made by
  // another agent keeps the user-post layout under that agent's name.
  if (block.author.kind === "user") {
    return (
      <Post
        author={author}
        at={block.createdAt}
        grouped={grouped}
        rule={rule}
        data-testid="chat-message"
        data-author="user"
        data-kind={block.kind}
        data-origin={block.origin}
        data-launched-by={block.launchedByAgentId}
        data-block-id={block.id}
        action={copyAction}
      >
        {block.origin === "launch" ? (
          <div
            className="mb-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground"
            title="What this agent was started with — the prompt, files and links from its launch."
            data-testid="chat-launch-context"
          >
            <Rocket className="h-3 w-3" aria-hidden="true" />
            Launch context
          </div>
        ) : null}
        {block.text ? (
          <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {block.text}
          </div>
        ) : null}
        {body}
        <AttachmentList attachments={block.attachments} ctx={ctx} />
        <DeliveryMeta block={block} held={held} />
        <ReactionBar
          reactions={reactions}
          agentName={ctx.agentName || "Agent"}
        />
        {threadLine}
      </Post>
    );
  }

  const { onToggleReaction } = ctx;
  const toggleReaction = onToggleReaction
    ? (emoji: string, remove: boolean) =>
        onToggleReaction(block.id, emoji, remove)
    : undefined;
  // Adding a reaction is delivered like a message, so the picker is disabled
  // whenever a message could not be sent; taking one back off never needs
  // the agent.
  const agentAction = (
    <div className="flex items-center gap-0.5">
      {toggleReaction ? (
        <ReactionPickerButton
          reactions={reactions}
          onToggle={toggleReaction}
          disabled={answersDisabled}
        />
      ) : null}
      {copyAction}
    </div>
  );

  return (
    <Post
      author={author}
      at={block.createdAt}
      grouped={grouped}
      rule={rule}
      side={side}
      // The drawer's review page is the review: give the card the width.
      flush={inThread && block.kind === "review"}
      data-testid="chat-message"
      data-author={author.kind === "peer" ? "peer" : "agent"}
      data-kind={block.kind}
      data-origin={block.origin}
      data-to-agent={block.toAgentId ?? undefined}
      data-block-id={block.id}
      action={agentAction}
    >
      {block.origin === "launch" ? (
        <div
          className="mb-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground"
          title="What the agent this is addressed to was started with."
          data-testid="chat-launch-context"
        >
          <Rocket className="h-3 w-3" aria-hidden="true" />
          Launch context
        </div>
      ) : null}
      {block.text ? <Markdown>{block.text}</Markdown> : null}
      {body}
      <AttachmentList attachments={block.attachments} ctx={ctx} />
      <DeliveryMeta block={block} held={false} />
      <ReactionBar
        reactions={reactions}
        agentName={author.name}
        onToggle={toggleReaction}
      />
      {threadLine}
    </Post>
  );
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * A quiet system line: smaller and dimmer than a post, its dot tucked into
 * the gutter and its text starting where the gutter ends, so a run of them
 * reads as a seam between posts rather than as posts of its own.
 */
export const StatusLine = memo(function StatusLine({
  entry,
  collapsedCount = 1,
}: {
  entry: ChatStatusEntry;
  collapsedCount?: number;
}): JSX.Element {
  const type = asEventType(entry.eventType);
  // A lifecycle mark Dispatch wrote (session started, stopped, resumed) reads
  // as a seam across the feed, like the day divider, rather than a status
  // post: no author gutter, hairlines to each side.
  if (entry.system) {
    return (
      <div
        className="my-1.5 flex items-center gap-3 px-4 text-[10.5px] text-muted-foreground/70"
        data-testid="chat-status"
        data-system="true"
        title={formatDateTime(entry.at)}
      >
        <span className="h-px flex-1 bg-border/60" />
        <span className="min-w-0 truncate">
          {entry.message || latestEventLabel(type)}
        </span>
        <span className="h-px flex-1 bg-border/60" />
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-2 px-4 py-px text-[10px] leading-4 text-muted-foreground/75"
      data-testid="chat-status"
      title={formatDateTime(entry.at)}
    >
      <div className="flex w-8 shrink-0 justify-end pr-0.5">
        <span
          className={cn(
            "h-1 w-1 rounded-full bg-current",
            latestEventColor(type)
          )}
        />
      </div>
      <span className="min-w-0 truncate">
        <span className="font-medium">{latestEventLabel(type)}</span>
        {entry.message ? ` · ${entry.message}` : null}
      </span>
      {collapsedCount > 1 ? (
        <span
          className="shrink-0 text-muted-foreground/70"
          data-testid="chat-status-collapsed-count"
        >
          ×{collapsedCount}
        </span>
      ) : null}
    </div>
  );
});
