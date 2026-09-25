import { UserAvatar } from "@/components/app/user-avatar/user-avatar";
import { DeliveryMeta } from "./chat-delivery-meta";
import { QueuedMessageActions } from "./queued-message-actions";
import { memo, type ReactNode, useMemo } from "react";
import type {
  Block,
  BlockAuthor,
  BlockStartup,
  BlockOption,
} from "@dispatch/shared";
import {
  Bot,
  Check,
  ChevronRight,
  Copy,
  MessageSquarePlus,
  MessagesSquare,
  Rocket,
} from "lucide-react";

import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { useCopyText } from "@/hooks/use-copy";
import { type AgentRelation, agentRelation } from "@/lib/agent-lineage";
import { AgentRelationBadge } from "@/components/app/agent-relation-badge";
import { AgentSeatBadge } from "@/components/app/agent-seat-badge";
import { Collapse } from "@/components/app/chat/collapse";
import { StepList } from "@/components/app/chat/turn/activity-block";
import { turnAnswerText } from "@/components/app/chat/turn/answer-text";
import type { Trace } from "@/components/app/chat/turn/contracts";
import { useChatRowState } from "@/components/app/chat/chat-row-state";
import { type FoldedEntry } from "@/components/app/chat/turn/turn-attachments";
import {
  isPendingTurn,
  PendingTurnLine,
  TurnAnswer,
} from "@/components/app/chat/turn/turn-entry-view";
import { MentionText } from "@/components/app/chat/mention-picker";
import { type Mentionable, mentionSpans } from "@/lib/mentions";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { lineageSeats } from "@/lib/agent-seat";
import { useAgentRecord } from "@/hooks/use-agent-tree";
import { cn } from "@/lib/utils";

import {
  type BlockStatePatch,
  FindingDetail,
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
  model?: string | null;
  relation: AgentRelation;
  /** Its number in the tree (the root is 1); absent outside this tree. */
  seat?: number;
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
  agents: readonly (Pick<Agent, "id" | "name" | "type" | "parentAgentId"> &
    Partial<Pick<Agent, "model" | "createdAt">>)[]
): PeerDirectory {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const seats = lineageSeats(agentId, agents);
  const peers: Record<string, PeerInfo> = {};
  for (const agent of agents) {
    if (agent.id === agentId) continue;
    peers[agent.id] = {
      name: agent.name,
      agentType: agent.type ?? null,
      model: agent.model ?? null,
      relation: agentRelation(agentId, agent.id, byId),
      ...(seats[agent.id] !== undefined ? { seat: seats[agent.id] } : {}),
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
  /** The agent's engine model, for the line under its name. */
  agentModel?: string | null;
  /** A model id as the catalog names it; absent, the chip shows the id. */
  modelLabel?: (agentType: string | null, model: string) => string;
  /** The agent's number in its tree, drawn as its avatar. */
  agentSeat?: number;
  agentType?: string | null;
  /** Other agents, for a peer post's avatar and relation; absent until loaded. */
  peers?: PeerDirectory;
  /**
   * Names for agents the directory no longer lists (archived), from the
   * page that mentions them. The directory wins when it has the agent.
   */
  names?: Readonly<Record<string, string>>;
  /** `order` scopes the lightbox's prev/next to those files, e.g. one post's images. */
  onOpenFile: (fileId: number, order?: number[]) => void;
  /** Opens the Changes tab on a file, at a line when one is given. */
  onOpenPath?: (path: string, line: number | null) => void;
  /**
   * Adds (`remove: false`) or takes back an emoji reaction on an agent's
   * block. Absent, the feed shows reactions but offers no way to change
   * them.
   */
  onToggleReaction?: (blockId: string, emoji: string, remove: boolean) => void;
  /** Opens a block's thread in the drawer, on one finding when given. */
  onOpenThread?: (blockId: string, findingId?: string) => void;
  /** Submits a form block's values. */
  onSubmitForm?: (
    blockId: string,
    values: Record<string, string | number | boolean>
  ) => void;
  /** `PATCH …/state`: cancel an ask or update a review/task. */
  onSetBlockState?: (blockId: string, patch: BlockStatePatch) => void;
  /** Block whose state patch is in flight, if any. */
  settingBlockStateId?: string | null;
  /** Sends a post the agent never took to it again. */
  onRetryDelivery?: (blockId: string) => void;
  /** Runs a failed turn again, from the turn's own answer block. */
  onRetryTurn?: (blockId: string) => void;
  /** Blocks with a retry in flight, so the row can say so. */
  retrying?: ReadonlySet<string>;
};

export type PostAuthor = {
  /** Consecutive posts with the same key can collapse under one header. */
  key: string;
  name: string;
  kind: "user" | "agent" | "peer";
  agentType?: string | null;
  /** The engine's model, when the agent list knows it. */
  model?: string | null;
  /** The model as the catalog names it, when it does. */
  modelLabel?: string;
  /** Peers only: how the sender stands to this agent. */
  relation?: AgentRelation;
  /** Its number in the tree, drawn as its avatar. */
  seat?: number;
  /**
   * A launch card's header: the record of an agent starting, not a post
   * the agent wrote. It wears a launch mark instead of the agent's face.
   */
  launch?: boolean;
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
    model: ctx.agentModel ?? null,
    ...labelled(ctx, ctx.agentType ?? null, ctx.agentModel ?? null),
    ...(ctx.agentSeat !== undefined ? { seat: ctx.agentSeat } : {}),
  };
}

function labelled(
  ctx: FeedContext,
  agentType: string | null,
  model: string | null
): { modelLabel?: string } {
  if (!model || !ctx.modelLabel) return {};
  return { modelLabel: ctx.modelLabel(agentType, model) };
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
    model: peer?.model ?? null,
    ...labelled(ctx, peer?.agentType ?? null, peer?.model ?? null),
    relation: peer?.relation ?? "agent",
    ...(peer?.seat !== undefined ? { seat: peer.seat } : {}),
  };
}

/**
 * Who a block reads as. A launch-context post made by another agent
 * (launch_agent) is that agent's, named from the agents list when it is
 * still there and from the page's names otherwise; every other user block is "You". An
 * agent block is this agent's, or a peer's when another agent wrote into
 * this stream.
 */
export function blockAuthor(block: Block, ctx: FeedContext): PostAuthor {
  // A launch card stands for the agent it launched: its header is that
  // agent's, whoever wrote the briefing.
  if (block.kind === "launch" && block.toAgentId) {
    const agent =
      block.toAgentId === ctx.agentId
        ? agentAuthor(ctx, "Agent")
        : peerAuthor(block.toAgentId, peerName(block.toAgentId, ctx), ctx);
    return launchHeader(agent, block.id);
  }
  if (block.author.kind === "agent") {
    const author =
      block.author.agentId === ctx.agentId
        ? agentAuthor(ctx, "Agent")
        : peerAuthor(
            block.author.agentId,
            peerName(block.author.agentId, ctx),
            ctx
          );
    return ranOn(author, block.turn?.model, ctx);
  }
  if (block.launchedByAgentId) {
    // The page's own agent launching a child reads as itself, not as an
    // unknown peer (the peer directory leaves the page's agent out).
    if (block.launchedByAgentId === ctx.agentId) {
      return agentAuthor(ctx, "Agent");
    }
    return peerAuthor(
      block.launchedByAgentId,
      peerName(block.launchedByAgentId, ctx),
      ctx
    );
  }
  return userAuthor();
}

/**
 * A turn wears the model it ran on, not the one the agent runs now: a
 * model switched mid-session must not relabel the turns before it.
 */
function ranOn(
  author: PostAuthor,
  model: string | undefined,
  ctx: FeedContext
): PostAuthor {
  if (!model || model === author.model) return author;
  const { modelLabel: _stale, ...rest } = author;
  return {
    ...rest,
    model,
    ...labelled(ctx, author.agentType ?? null, model),
  };
}

/**
 * A launch card's header: which agent started, told apart from anything the
 * agent itself posts — "Started <name>" under a launch mark — with the same
 * engine, model and relation chips its posts carry.
 */
function launchHeader(agent: PostAuthor, blockId: string): PostAuthor {
  return {
    ...agent,
    key: `launch:${blockId}`,
    name: `Started ${agent.name}`,
    launch: true,
  };
}

/** Who the agent a block stands for is, as its posts read: a launch card's agent itself. */
export function blockIdentity(block: Block, ctx: FeedContext): PostAuthor {
  if (block.kind === "launch" && block.toAgentId) {
    return block.toAgentId === ctx.agentId
      ? agentAuthor(ctx, "Agent")
      : peerAuthor(block.toAgentId, peerName(block.toAgentId, ctx), ctx);
  }
  return blockAuthor(block, ctx);
}

/**
 * Another agent's name: from the live directory, else from the page (an
 * archived agent keeps its name), else "Agent".
 */
function peerName(agentId: string, ctx: FeedContext): string {
  return ctx.peers?.[agentId]?.name ?? ctx.names?.[agentId] ?? "Agent";
}

/** An agent's name as this feed knows it: the page's agent, a peer, or "Agent". */
export function agentDisplayName(agentId: string, ctx: FeedContext): string {
  if (agentId === ctx.agentId) return ctx.agentName || "Agent";
  return peerName(agentId, ctx);
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
  if (block.toAgentId === null || block.kind === "launch") return undefined;
  if (block.author.kind === "agent") {
    return { recipientName: agentDisplayName(block.toAgentId, ctx) };
  }
  // A person's post says whom it was for when that is not the page's
  // agent, or when it named several: "You → reviewer, builder".
  const recipients = blockRecipients(block);
  if (recipients.length === 1 && recipients[0] === ctx.agentId) {
    return undefined;
  }
  return {
    recipientName: recipients.map((id) => agentDisplayName(id, ctx)).join(", "),
  };
}

/** Everyone a post was delivered to: its `@mentions` or recipients, or its one recipient. */
export function blockRecipients(block: Block): string[] {
  const data = block.kind === "text" ? block.data : undefined;
  const named = data?.mentions?.length ? data.mentions : data?.recipients;
  if (named && named.length > 0) return named;
  return block.toAgentId ? [block.toAgentId] : [];
}

/** The agents a person can name with `@` on this page: the tree, by seat. */
export function mentionablesOf(ctx: FeedContext): Mentionable[] {
  const list: Mentionable[] = [];
  if (ctx.agentId) {
    list.push({
      id: ctx.agentId,
      name: ctx.agentName ?? "Agent",
      ...(ctx.agentSeat !== undefined ? { seat: ctx.agentSeat } : {}),
    });
  }
  for (const [id, peer] of Object.entries(ctx.peers ?? {})) {
    if (peer.seat === undefined) continue;
    list.push({ id, name: peer.name, seat: peer.seat });
  }
  return list.sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99));
}

export function Avatar({ author }: { author: PostAuthor }): JSX.Element {
  if (author.launch) {
    return (
      <span
        className="flex h-8 w-8 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground"
        aria-label={author.name}
        title={author.name}
        data-testid="chat-avatar-launch"
      >
        <Rocket className="h-4 w-4" aria-hidden="true" />
      </span>
    );
  }
  if (author.kind === "user") return <UserAvatar />;
  // An agent in the tree wears its number in its own colour; one the list
  // no longer knows wears a plain face. The engine and model are said in
  // the chips under the name, not guessed from a logo.
  if (author.seat !== undefined) {
    return <AgentSeatBadge seat={author.seat} name={author.name} />;
  }
  return (
    <span
      className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted/50 text-foreground/80"
      aria-label={`${author.name}, agent`}
      title={author.name}
      data-testid="chat-avatar-agent"
    >
      <Bot className="h-[18px] w-[18px]" aria-hidden="true" />
    </span>
  );
}

/**
 * The line under an agent's name: which engine, which model, and how it
 * stands to this agent when it is another one (a child, its parent). Every
 * agent in the stream is told apart the same way, not only the page's own.
 */
export function AuthorMeta({
  author,
}: {
  author: PostAuthor;
}): JSX.Element | null {
  if (author.kind === "user") return null;
  const engine = agentTypeLabel(author.agentType);
  const model = author.model ? (author.modelLabel ?? author.model) : null;
  const relation =
    author.relation && author.relation !== "agent" ? author.relation : null;
  if (!engine && !model && !relation) return null;
  return (
    <span
      className="flex basis-full flex-wrap items-center gap-1 leading-4"
      data-testid="chat-author-meta"
    >
      {engine ? (
        <span
          className="rounded border border-border/70 bg-muted/40 px-1 text-[10px] font-medium text-muted-foreground"
          data-testid="chat-author-engine"
        >
          {engine}
        </span>
      ) : null}
      {model ? (
        <span
          className="max-w-[16rem] truncate rounded border border-border/70 bg-muted/40 px-1 text-[10px] text-muted-foreground"
          title={author.model ?? undefined}
          data-testid="chat-author-model"
        >
          {model}
        </span>
      ) : null}
      {relation ? <AgentRelationBadge relation={relation} /> : null}
    </span>
  );
}

/** "Claude" / "Codex" for an engine id; null for an unknown one. */
export function agentTypeLabel(type: string | null | undefined): string | null {
  if (type === "claude") return "Claude";
  if (type === "codex") return "Codex";
  return null;
}

/**
 * Who a post reads as, at a glance: "You" and other agents get a faint
 * full-width tint so their posts stand apart from this agent's prose, which
 * stays plain. The tint runs the whole author group, so a run of posts
 * reads as one block.
 */
export const POST_TINT: Record<PostAuthor["kind"], string> = {
  // A neutral wash separates the user without borrowing the theme's accent hue.
  user: "chat-user-wash",
  // Agent-to-agent traffic is a side conversation the user is overhearing, so
  // it recedes — indent and muted body carry it, with no fill of its own.
  peer: "hover:bg-muted/30",
  agent: "hover:bg-muted/40",
};

/** Keep post bodies and turn details within the full available stream width. */
export const POST_BODY_MEASURE = "max-w-full";

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
        <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
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
        // An agent-to-agent post sits in the same column as every other
        // row: the "→ recipient" in its header says who it was for. An
        // indent read as a different, harder-to-follow kind of message.
        flush ? "px-3" : "px-4",
        side && author.kind !== "user"
          ? POST_TINT.peer
          : POST_TINT[author.kind],
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
            <Avatar author={author} />
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
            <AuthorMeta author={author} />
          </div>
        )}
        <div
          className={cn("min-w-0 text-sm text-foreground", POST_BODY_MEASURE)}
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

/** "3 replies · last 2m ago", the line that opens a block's thread. */
export function replyLine(block: Block): string | null {
  const count = block.replyCount ?? 0;
  if (count === 0) return null;
  const head = `${count} ${count === 1 ? "reply" : "replies"}`;
  const last = block.lastReplyAt ? formatRelativeTime(block.lastReplyAt) : "";
  return last ? `${head} · last ${last}` : head;
}

/** How many replier faces the thread row shows before "+n". */
const THREAD_FACES = 4;

/**
 * The row under a post that has a thread: who has written in it (their
 * faces, in order of appearance), how many replies, when the last one
 * came, and how many the person has not read. The count is the link.
 */
function ThreadLine({
  block,
  ctx,
}: {
  block: Block;
  ctx: FeedContext;
}): JSX.Element | null {
  const count = block.replyCount ?? 0;
  if (count === 0) return null;
  const onOpen = ctx.onOpenThread;
  const unread = block.unreadReplies ?? 0;
  const repliers = block.repliers ?? [];
  const last = block.lastReplyAt ? formatRelativeTime(block.lastReplyAt) : "";
  return (
    <button
      type="button"
      className="group/thread mt-2 flex w-fit max-w-full items-center gap-2 text-[11px] leading-none disabled:cursor-default"
      disabled={!onOpen}
      data-testid="chat-thread-line"
      data-reply-count={String(count)}
      data-unread-replies={unread > 0 ? String(unread) : undefined}
      onClick={() => onOpen?.(block.id)}
    >
      {repliers.length > 0 ? (
        <span
          className="flex items-center -space-x-1"
          data-testid="chat-thread-faces"
        >
          {repliers.slice(0, THREAD_FACES).map((who, index) => (
            <ReplierFace key={index} who={who} ctx={ctx} />
          ))}
          {repliers.length > THREAD_FACES ? (
            <span className="flex h-5 min-w-5 items-center justify-center rounded border border-border bg-background px-1 font-mono text-[9px] text-muted-foreground">
              +{repliers.length - THREAD_FACES}
            </span>
          ) : null}
        </span>
      ) : (
        <MessagesSquare
          className="ml-0.5 h-3.5 w-3.5 text-muted-foreground"
          aria-hidden="true"
        />
      )}
      <span className="font-medium text-status-done underline-offset-2 group-hover/thread:underline group-disabled/thread:no-underline">
        {count} {count === 1 ? "reply" : "replies"}
      </span>
      {unread > 0 ? (
        <span
          className="rounded-full bg-status-done px-1.5 py-0.5 text-[10px] font-semibold text-background"
          data-testid="chat-thread-unread"
        >
          {unread} new
        </span>
      ) : null}
      {last ? <span className="text-muted-foreground">last {last}</span> : null}
    </button>
  );
}

/** One face in a thread row: the person, an agent's seat, or a plain agent. */
function ReplierFace({
  who,
  ctx,
}: {
  who: BlockAuthor;
  ctx: FeedContext;
}): JSX.Element {
  const ring = "ring-2 ring-background";
  if (who.kind === "user") {
    return (
      <UserAvatar
        className={cn("h-5 w-5", ring)}
        testId="chat-thread-replier"
      />
    );
  }
  const own = who.agentId === ctx.agentId;
  const peer = own ? undefined : ctx.peers?.[who.agentId];
  const seat = own ? ctx.agentSeat : peer?.seat;
  const name = own ? (ctx.agentName ?? "Agent") : (peer?.name ?? "Agent");
  if (seat !== undefined) {
    return (
      <AgentSeatBadge
        seat={seat}
        name={name}
        size="sm"
        className={ring}
        data-testid="chat-thread-replier"
      />
    );
  }
  return (
    <span
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded border border-border bg-muted/50 text-foreground/80",
        ring
      )}
      title={name}
      data-testid="chat-thread-replier"
    >
      <Bot className="h-3 w-3" aria-hidden="true" />
    </span>
  );
}

/**
 * A block's body by kind, under its text. `text` and `file` have nothing
 * past the text and the attachments; every other kind hangs its own view.
 * `threadRootId` is the thread page this is drawn on, when it is: a
 * finding opens over it.
 */
function BlockBody({
  block,
  ctx,
  answering,
  answersDisabled,
  submitting,
  onAnswer,
  inThread,
  threadRootId,
  highlightFindingId,
}: {
  block: Block;
  ctx: FeedContext;
  answering: boolean;
  answersDisabled: boolean;
  submitting: boolean;
  onAnswer: (blockId: string, option: BlockOption) => void;
  inThread: boolean;
  threadRootId: string;
  highlightFindingId: string | null;
}): JSX.Element | null {
  const { onSubmitForm, onSetBlockState, onOpenThread, onOpenPath } = ctx;
  const setState = onSetBlockState
    ? (patch: BlockStatePatch) => onSetBlockState(block.id, patch)
    : undefined;
  const cancelAsk =
    setState && block.author.kind === "agent" && block.toAgentId === null
      ? () => setState({ cancellation: true })
      : undefined;
  switch (block.kind) {
    case "question":
      return (
        <QuestionOptions
          block={block}
          answering={answering}
          answersDisabled={answersDisabled}
          canceling={ctx.settingBlockStateId === block.id}
          onAnswer={(option) => onAnswer(block.id, option)}
          onCancel={cancelAsk}
        />
      );
    case "form":
      return (
        <FormBlockBody
          block={block}
          submitting={submitting}
          disabled={answersDisabled || !onSubmitForm}
          canceling={ctx.settingBlockStateId === block.id}
          onSubmit={(values) => onSubmitForm?.(block.id, values)}
          onCancel={cancelAsk}
        />
      );
    case "review":
      return (
        <ReviewBlockBody
          block={block}
          onOpenFinding={
            onOpenThread
              ? (findingId) => onOpenThread(threadRootId, findingId)
              : undefined
          }
          onOpenPath={onOpenPath}
          // In the stream the card is a summary that opens its thread in
          // the drawer; in the drawer it is the whole subject, open.
          compact={!inThread}
          onOpen={onOpenThread ? () => onOpenThread(threadRootId) : undefined}
          defaultExpanded={inThread}
          highlightFindingId={highlightFindingId}
        />
      );
    case "finding":
      return (
        <div className="mt-1">
          <FindingDetail
            block={block}
            disabled={answersDisabled || !onSetBlockState}
            onSetState={
              onSetBlockState
                ? (patch) => onSetBlockState(block.id, patch)
                : undefined
            }
            onOpenPath={onOpenPath}
            authorName={(by) =>
              by.kind === "user" ? "you" : agentDisplayName(by.agentId, ctx)
            }
          />
        </div>
      );
    case "launch":
      return <LaunchCardBody block={block} ctx={ctx} />;
    case "tasks":
      return <TasksBlockBody block={block} />;
    case "link":
      return <LinkBlockBody block={block} />;
    case "text":
    case "file":
      return null;
  }
}

/**
 * The blocks a block shows, under its own body: a launch card's review, a
 * review's findings being the review's own business. Each is a block of
 * its own — its own state, its own thread — drawn as part of the post that
 * shows it rather than as a post of its own, so it carries no header.
 */
function ShownBlocks({
  block,
  ctx,
  inThread,
  threadRootId,
  highlightFindingId,
  answersDisabled,
  onAnswer,
}: {
  block: Block;
  ctx: FeedContext;
  inThread: boolean;
  threadRootId: string;
  highlightFindingId: string | null;
  answersDisabled: boolean;
  onAnswer: (blockId: string, option: BlockOption) => void;
}): JSX.Element | null {
  // A review's body is the list of its findings: it draws what it shows.
  if (block.kind === "review") return null;
  const shown = block.blocks ?? [];
  if (shown.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="chat-shown-blocks">
      {shown.map((item) => (
        <div
          key={item.id}
          data-testid="chat-shown-block"
          data-block-id={item.id}
          data-kind={item.kind}
        >
          {/* The shown block's own content, all of it: its words, its kind's
              body, its attachments, and the blocks it shows in turn. */}
          {item.text ? <Markdown>{item.text}</Markdown> : null}
          <BlockBody
            block={item}
            ctx={ctx}
            answering={false}
            answersDisabled={answersDisabled}
            submitting={false}
            onAnswer={onAnswer}
            inThread={inThread}
            threadRootId={threadRootId}
            highlightFindingId={highlightFindingId}
          />
          <AttachmentList block={item} ctx={ctx} />
          <ShownBlocks
            block={item}
            ctx={ctx}
            inThread={inThread}
            threadRootId={threadRootId}
            highlightFindingId={highlightFindingId}
            answersDisabled={answersDisabled}
            onAnswer={onAnswer}
          />
        </div>
      ))}
    </div>
  );
}

export type BlockViewProps = {
  block: Block;
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
  /** Inside a thread page: no reply line, no thread to open. */
  inThread?: boolean;
  /** The thread page this is drawn on, when it is one. */
  threadRoot?: string | null;
  /** A review's finding to pick out (the panel's `?finding=`). */
  highlightFindingId?: string | null;
  /** A turn block only: what the agent produced while the turn ran, folded under its answer. */
  folded?: readonly FoldedEntry[];
};

/** "Started in 12s": how long a finished startup took. */
function startupDuration(startup: BlockStartup): string | null {
  const first = Date.parse(startup.steps[0]?.startedAt ?? "");
  const last = Date.parse(startup.readyAt ?? "");
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  const seconds = Math.max(0, (last - first) / 1000);
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/**
 * One part of a launch card that folds: a short line (what it is, and a
 * note on it) that opens onto the whole.
 */
function LaunchSection({
  title,
  aside,
  stateKey,
  defaultOpen,
  testId,
  children,
}: {
  title: string;
  aside?: string;
  stateKey: string;
  defaultOpen: boolean;
  testId: string;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useChatRowState<boolean>(stateKey, defaultOpen);
  return (
    <div data-testid={testId} data-open={open ? "true" : "false"}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 py-0.5 text-left text-[12px] text-muted-foreground hover:text-foreground"
        data-testid={`${testId}-toggle`}
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform",
            open && "rotate-90"
          )}
          aria-hidden="true"
        />
        <span className="shrink-0 font-medium">{title}</span>
        {aside ? <span className="min-w-0 truncate">{aside}</span> : null}
      </button>
      <Collapse open={open} data-testid={`${testId}-body`}>
        <div className="pb-1 pl-[18px] pt-1">{children}</div>
      </Collapse>
    </div>
  );
}

/** The first line of some text, for a folded section's note. */
function firstLineOf(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > 90 ? `${line.slice(0, 89).trimEnd()}…` : line;
}

/**
 * A launch card's own body: who launched the agent, where it stands now
 * (read from the agent, so it stays current), the briefing it was given,
 * its workspace coming up, and the instructions it runs with. Startup
 * stands open while it runs and folds to one line once the agent is up.
 */
function LaunchCardBody({
  block,
  ctx,
}: {
  block: Extract<Block, { kind: "launch" }>;
  ctx: FeedContext;
}): JSX.Element {
  const agent = useAgentRecord(block.toAgentId);
  const state = block.state ?? {};
  const startup = state.startup;
  const trace = useMemo(() => startupTrace(startup), [startup]);
  const launcher = block.launchedByAgentId
    ? agentDisplayName(block.launchedByAgentId, ctx)
    : "you";
  const starting = !!startup && !startup.readyAt && !startup.failed;
  const took = startup ? startupDuration(startup) : null;
  return (
    <div className="flex flex-col gap-0.5" data-testid="chat-launch-card-body">
      <div
        className="mb-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground"
        data-testid="chat-launch-meta"
      >
        <span className="inline-flex items-center gap-1">
          <Rocket className="h-3 w-3" aria-hidden="true" />
          Launched by {launcher}
        </span>
        {agent?.persona ? (
          <span
            className="rounded border border-border/70 bg-muted/40 px-1 text-[10px] font-medium"
            data-testid="chat-launch-persona"
          >
            {agent.persona}
          </span>
        ) : null}
      </div>
      {block.text ? (
        <LaunchSection
          title="Briefing"
          aside={firstLineOf(block.text)}
          stateKey="launch-briefing-open"
          // A person's own words open; a briefing an agent wrote folds.
          defaultOpen={!block.launchedByAgentId}
          testId="chat-launch-briefing"
        >
          <Markdown>{block.text}</Markdown>
        </LaunchSection>
      ) : null}
      {startup && startup.steps.length > 0 ? (
        starting ? (
          <div
            className="w-full min-w-0 font-terminal"
            data-testid="chat-launch-startup"
          >
            <StepList trace={trace} />
          </div>
        ) : (
          <LaunchSection
            title={startup.failed ? "Startup failed" : "Started"}
            aside={startup.failed ?? (took ? `in ${took}` : undefined)}
            stateKey="launch-startup-open"
            defaultOpen={!!startup.failed}
            testId="chat-launch-startup"
          >
            <div className="w-full min-w-0 font-terminal">
              <StepList trace={trace} />
            </div>
          </LaunchSection>
        )
      ) : null}
      {state.instructions ? (
        <LaunchSection
          title="Instructions"
          aside={`${state.instructions.split("\n").length} lines`}
          stateKey="launch-instructions-open"
          defaultOpen={false}
          testId="chat-launch-instructions"
        >
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {state.instructions}
          </pre>
        </LaunchSection>
      ) : null}
    </div>
  );
}

/**
 * One block as a post: the author header, the text, the kind's own body,
 * the blocks it shows, the attachments, and then the delivery state (a
 * person's block), the reactions, and the thread's reply line.
 */
/**
 * The startup record as the step list's own model. The worktree step
 * carries the directory it made and a failed step carries the reason, in
 * the aside the list shows beside a step's name.
 */
function startupTrace(startup: BlockStartup | undefined): Trace {
  const steps = startup?.steps ?? [];
  const at = (iso: string | undefined): number | undefined => {
    if (!iso) return undefined;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : undefined;
  };
  const first = at(steps[0]?.startedAt) ?? Date.now();
  const last = steps.reduce(
    (latest, step) => Math.max(latest, at(step.endedAt) ?? 0),
    0
  );
  const ended = startup?.failed || startup?.readyAt ? last || first : undefined;
  return {
    startedAt: first,
    ...(ended !== undefined ? { endedAt: ended } : {}),
    ...(startup?.failed ? { finalResult: "error" as const } : {}),
    steps: steps.map((step) => {
      const startedAt = at(step.startedAt) ?? first;
      const endedAt = at(step.endedAt);
      // A path keeps its end, where the directory's own name is; a reason
      // keeps its start.
      const path =
        !step.detail && step.phase === "worktree" ? startup?.cwd : undefined;
      const aside = step.detail ?? path;
      return {
        id: step.phase,
        kind: "setup",
        label: step.label,
        status:
          step.status === "failed"
            ? ("error" as const)
            : step.status === "done"
              ? ("ok" as const)
              : ("running" as const),
        startedAt,
        ...(endedAt !== undefined
          ? { endedAt, durMs: Math.max(0, endedAt - startedAt) }
          : {}),
        ...(aside
          ? { detail: { text: aside, ...(path ? { clipStart: true } : {}) } }
          : {}),
      };
    }),
  };
}

export const BlockView = memo(function BlockView({
  block,
  grouped,
  rule = false,
  ctx,
  answering,
  submitting = false,
  answersDisabled = false,
  onAnswer,
  inThread = false,
  threadRoot = null,
  highlightFindingId = null,
  folded,
}: BlockViewProps): JSX.Element {
  const author = blockAuthor(block, ctx);
  // Inside the panel the thread itself says who is talking to whom; the
  // side indent would only push the replies off the left edge.
  const side = inThread ? undefined : blockSide(block, ctx);
  const replyAction =
    !inThread && ctx.onOpenThread ? (
      <ReplyInThreadButton onClick={() => ctx.onOpenThread?.(block.id)} />
    ) : null;
  const copyText = block.turn ? turnAnswerText(block, block.turn) : block.text;
  const copyAction =
    copyText || replyAction ? (
      <div className="flex items-center">
        {replyAction}
        {copyText ? <MessageCopyButton text={copyText} /> : null}
      </div>
    ) : undefined;
  const reactions = block.reactions ?? [];
  const threadLine = inThread ? null : <ThreadLine block={block} ctx={ctx} />;
  // The thread this post opens onto: its own, or the one it is drawn in.
  const threadRootId = threadRoot ?? block.id;
  const body = (
    <>
      <BlockBody
        block={block}
        ctx={ctx}
        answering={answering}
        answersDisabled={answersDisabled}
        submitting={submitting}
        onAnswer={onAnswer}
        inThread={inThread}
        threadRootId={threadRootId}
        highlightFindingId={highlightFindingId}
      />
      <ShownBlocks
        block={block}
        ctx={ctx}
        inThread={inThread}
        threadRootId={threadRootId}
        highlightFindingId={highlightFindingId}
        answersDisabled={answersDisabled}
        onAnswer={onAnswer}
      />
    </>
  );

  // A person's block, whoever it reads as: a launch-context post made by
  // another agent keeps the user-post layout under that agent's name.
  // A launch card reads as the agent it launched (see `blockAuthor`), so
  // it takes the agent layout below, whoever wrote the briefing.
  if (block.author.kind === "user" && block.kind !== "launch") {
    return (
      <Post
        author={author}
        at={block.createdAt}
        grouped={grouped}
        rule={rule}
        side={side}
        data-testid="chat-message"
        data-author="user"
        data-kind={block.kind}
        data-origin={block.origin}
        data-launched-by={block.launchedByAgentId}
        data-block-id={block.id}
        action={copyAction}
      >
        {block.text ? (
          <Markdown
            className="prose-p:whitespace-pre-line prose-li:whitespace-pre-line"
            renderText={(text) => (
              <MentionText spans={mentionSpans(text, mentionablesOf(ctx))} />
            )}
          >
            {block.text}
          </Markdown>
        ) : null}
        {body}
        <AttachmentList block={block} ctx={ctx} />
        {block.delivered === null && block.toAgentId && !block.origin ? (
          <QueuedMessageActions
            agentId={block.streamId}
            messageId={block.id}
            canSendNow={!(block.kind === "text" && block.data?.acpCommand)}
            status={
              <DeliveryMeta
                block={block}
                recipientName={(id) => agentDisplayName(id, ctx)}
                retrying={ctx.retrying?.has(block.id)}
                onRetryDelivery={ctx.onRetryDelivery}
              />
            }
          />
        ) : (
          <DeliveryMeta
            block={block}
            recipientName={(id) => agentDisplayName(id, ctx)}
            retrying={ctx.retrying?.has(block.id)}
            onRetryDelivery={ctx.onRetryDelivery}
          />
        )}
        <ReactionBar
          reactions={reactions}
          agentName={ctx.agentName || "Agent"}
        />
        {threadLine}
      </Post>
    );
  }

  // A turn with nothing to say yet is a status line, not a second post:
  // it takes the full header once the reply's first words arrive.
  if (block.turn && !inThread && isPendingTurn(block, block.turn, folded)) {
    return (
      <PendingTurnLine
        block={block}
        turn={block.turn}
        name={author.name}
        avatar={
          author.seat !== undefined ? (
            <AgentSeatBadge seat={author.seat} name={author.name} size="sm" />
          ) : (
            <Bot
              className="h-4 w-4 text-muted-foreground"
              aria-label={`${author.name}, agent`}
            />
          )
        }
      />
    );
  }

  const { onToggleReaction } = ctx;
  // A launch card is a record Dispatch keeps, not something to react to.
  const toggleReaction =
    onToggleReaction && block.kind !== "launch"
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
      data-launch-card={block.kind === "launch" ? "true" : undefined}
      // A launch card is a record of an agent, not a message in the
      // conversation: it answers to its own name.
      data-testid={
        block.kind === "launch" ? "chat-launch-card" : "chat-message"
      }
      data-author={author.kind === "peer" ? "peer" : "agent"}
      data-kind={block.kind}
      data-origin={block.origin}
      data-to-agent={block.toAgentId ?? undefined}
      data-block-id={block.id}
      action={agentAction}
    >
      {block.turn ? (
        <TurnAnswer block={block} turn={block.turn} ctx={ctx} folded={folded} />
      ) : block.text && block.kind !== "launch" ? (
        <Markdown>{block.text}</Markdown>
      ) : null}
      {body}
      <AttachmentList block={block} ctx={ctx} />
      {block.kind === "launch" ? null : (
        <DeliveryMeta
          block={block}
          recipientName={(id) => agentDisplayName(id, ctx)}
          retrying={ctx.retrying?.has(block.id)}
          onRetryDelivery={ctx.onRetryDelivery}
        />
      )}
      <ReactionBar
        reactions={reactions}
        agentName={author.name}
        onToggle={toggleReaction}
      />
      {threadLine}
    </Post>
  );
});
