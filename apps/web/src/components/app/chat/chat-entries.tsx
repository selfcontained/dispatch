import { memo, type ReactNode, useMemo } from "react";
import type {
  Block,
  BlockAuthor,
  BlockDeliveryState,
  BlockStartup,
  BlockOption,
} from "@dispatch/shared";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  Copy,
  Hourglass,
  Loader2,
  MessageSquarePlus,
  MessagesSquare,
  Rocket,
  ScrollText,
  UserRound,
} from "lucide-react";

import {
  latestEventColor,
  latestEventLabel,
} from "@/components/app/agent-event-utils";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { useCopyText } from "@/hooks/use-copy";
import { type AgentRelation, agentRelation } from "@/lib/agent-lineage";
import { AgentRelationBadge } from "@/components/app/agent-relation-badge";
import { AgentSeatBadge } from "@/components/app/agent-seat-badge";
import { Collapse } from "@/components/app/chat/collapse";
import { ActivityBlock } from "@/components/app/chat/turn/activity-block";
import type { Trace } from "@/components/app/chat/turn/contracts";
import { useChatRowState } from "@/components/app/chat/chat-row-state";
import {
  type FoldedEntry,
} from "@/components/app/chat/turn/turn-attachments";
import { TurnAnswer } from "@/components/app/chat/turn/turn-entry-view";
import { MentionText } from "@/components/app/chat/mention-picker";
import { type Mentionable, mentionSpans } from "@/lib/mentions";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { lineageSeats } from "@/lib/agent-seat";
import { useThread } from "@/hooks/use-stream";
import { cn } from "@/lib/utils";

import {
  type BlockStatePatch,
  FormBlockBody,
  LinkBlockBody,
  QuestionOptions,
  ReviewBlockBody,
  TasksBlockBody,
  findingIdOf,
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
  onOpenFile: (fileId: number) => void;
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
  /** `PATCH …/state`: resolve, dispute or reopen a finding. */
  onSetBlockState?: (blockId: string, patch: BlockStatePatch) => void;
  /** Sends a post the agent never took to it again. */
  onRetryDelivery?: (blockId: string) => void;
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
    // The page's own agent launching a child reads as itself, not as an
    // unknown peer (the peer directory leaves the page's agent out).
    if (block.launchedByAgentId === ctx.agentId) {
      return agentAuthor(ctx, "Agent");
    }
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
  if (block.toAgentId === null) return undefined;
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
    recipientName: recipients
      .map((id) => agentDisplayName(id, ctx))
      .join(", "),
  };
}

/** Everyone a post was delivered to: its `@mentions`, or its one recipient. */
export function blockRecipients(block: Block): string[] {
  const mentions =
    block.kind === "text" ? block.data?.mentions : undefined;
  if (mentions && mentions.length > 0) return mentions;
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

function Avatar({ author }: { author: PostAuthor }): JSX.Element {
  if (author.kind === "user") {
    return (
      <span
        className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-foreground/[0.08] text-foreground"
        aria-label="You"
        title="You"
        data-testid="chat-avatar-user"
      >
        <UserRound className="h-4 w-4" aria-hidden="true" />
      </span>
    );
  }
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
        side && author.kind !== "user" ? POST_TINT.peer : POST_TINT[author.kind],
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
          className={cn(
            "min-w-0 max-w-full text-sm text-foreground",
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

/** The recipients of a post in one of the states worth reporting. */
function inState(
  block: Block,
  state: BlockDeliveryState
): readonly string[] {
  return (block.delivery ?? [])
    .filter((entry) => entry.state === state)
    .map((entry) => entry.agentId);
}

/** "builder", "builder and reviewer", "builder, reviewer and scout". */
function nameList(agentIds: readonly string[], ctx: FeedContext): string {
  const names = agentIds.map((id) => agentDisplayName(id, ctx));
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Where a post addressed to agents has got to, and nothing once every
 * recipient has it. A message here is queued rather than posted, which is
 * the part a reader has to be able to see: waiting behind a turn is a
 * normal state a message sits in, not a failure, and it says so in as many
 * words. Recipients are named only when a post went to more than one, so
 * an ordinary message keeps its quiet single line.
 */
function DeliveryMeta({
  block,
  ctx,
}: {
  block: Block;
  ctx: FeedContext;
}): JSX.Element | null {
  if (block.toAgentId === null || !block.delivery?.length) return null;
  const several = block.delivery.length > 1;
  const failed = inState(block, "failed");
  const held = inState(block, "held");
  const pending = inState(block, "pending");
  const retrying = ctx.retrying?.has(block.id) ?? false;

  if (failed.length > 0) {
    return (
      <div
        className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-destructive"
        title="The message was not taken: the agent had no session, or its engine stopped responding."
        data-testid="chat-delivery-failed"
      >
        <AlertTriangle className="h-3 w-3" />
        {several
          ? `Not delivered to ${nameList(failed, ctx)}`
          : "Not delivered"}
        {/* The same post, sent again, and only to whoever missed it:
            nothing new lands in the stream and nobody reads it twice. */}
        {ctx.onRetryDelivery ? (
          <button
            type="button"
            className="underline underline-offset-2 hover:no-underline disabled:opacity-60"
            disabled={retrying}
            onClick={() => ctx.onRetryDelivery?.(block.id)}
            data-testid="chat-delivery-retry"
          >
            {retrying ? "Retrying…" : "Retry"}
          </button>
        ) : null}
      </div>
    );
  }
  if (held.length > 0) {
    return (
      <div
        className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground"
        title="The agent is mid-turn. Your message is queued and reaches it when the turn ends; Send now cuts the turn short."
        data-testid="chat-held-hint"
      >
        <Hourglass className="h-3 w-3" />
        {several
          ? `Queued for ${nameList(held, ctx)}, until the turn ends`
          : "Queued until the turn ends"}
      </div>
    );
  }
  if (pending.length > 0) {
    return (
      <div
        className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground"
        title="On its way to the agent."
        data-testid="chat-delivery-pending"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        {several ? `Sending to ${nameList(pending, ctx)}` : "Sending"}
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
        <span className="flex items-center -space-x-1" data-testid="chat-thread-faces">
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
        <MessagesSquare className="ml-0.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
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
      <span
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded border border-border bg-foreground/[0.08] text-foreground",
          ring
        )}
        title="You"
        data-testid="chat-thread-replier"
      >
        <UserRound className="h-3 w-3" aria-hidden="true" />
      </span>
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
  /** A review's finding to pick out (the panel's `?finding=`). */
  highlightFindingId?: string | null;
  /** A turn block only: what the agent produced while the turn ran, folded under its answer. */
  folded?: readonly FoldedEntry[];
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
    const findingId = findingIdOf(reply);
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
    const findingId = findingIdOf(reply) ?? "";
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

/**
 * What the agent was told at launch, as a row of the stream rather than a
 * chip in it: the full width and the same gutter every post uses, its icon
 * where an avatar would be, and the prompt itself folded away until asked
 * for. Not a post — nobody wrote it to anybody — so it carries no author
 * and none of a post's actions, and it reads as the startup record it is.
 */
function SystemPromptBlock({ block }: { block: Block }): JSX.Element {
  const [open, setOpen] = useChatRowState<boolean>("system-prompt-open", false);
  const lines = block.text.split("\n").length;
  return (
    <div
      className="mt-3 flex min-w-0 max-w-full flex-col px-4 pb-1.5 pt-2"
      data-testid="chat-system-prompt"
      data-open={open ? "true" : "false"}
      data-block-id={block.id}
    >
      {/* The header is its own flex row, so the icon and the title centre
          on each other whatever either one's height turns out to be. The
          prompt unfolds underneath rather than beside, so nothing here
          depends on the icon's size. */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-3 text-left"
        data-testid="chat-system-prompt-toggle"
      >
        <span
          className="flex shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 p-2 text-muted-foreground"
          aria-hidden="true"
        >
          <ScrollText className="h-4 w-4" />
        </span>
        <span className="truncate text-sm font-semibold text-foreground">
          Started with these instructions
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {lines} lines
        </span>
        <ChevronRight
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
          aria-hidden="true"
        />
      </button>
      <Collapse open={open} data-testid="chat-system-prompt-body">
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {block.text}
        </pre>
      </Collapse>
    </div>
  );
}

/**
 * The workspace coming up, as a row of the stream, drawn as the agent's
 * own activity is: the same summary line, the same step rail, the same
 * glyphs and durations. Creating a worktree and installing dependencies
 * are work an agent is doing, and there is no reason for them to look
 * like a different kind of thing.
 */
function WorkspaceBlock({ block }: { block: Block }): JSX.Element {
  const startup = block.kind === "text" ? block.data?.startup : undefined;
  const trace = useMemo(() => startupTrace(startup), [startup]);
  // The summary line names the running step by itself, the way it does
  // for a turn; this is what it reads once there is no step running.
  const label = startup?.readyAt ? "workspace ready" : "setting up";
  return (
    <div
      className="mt-3 flex min-w-0 max-w-full flex-col px-4 pb-1.5 pt-2"
      data-testid="chat-workspace"
      data-state={
        startup?.failed ? "failed" : startup?.readyAt ? "ready" : "running"
      }
      data-block-id={block.id}
    >
      <div
        className={cn(POST_BODY_MEASURE, "w-full min-w-0 font-terminal")}
      >
        <ActivityBlock trace={trace} label={label} />
      </div>
    </div>
  );
}

/**
 * The startup record as the activity rail's own model. The worktree step
 * carries the directory it made and a failed step carries the reason, in
 * the aside the rail shows beside a step's name.
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
      const aside =
        step.detail ??
        (step.phase === "worktree" ? startup?.cwd : undefined);
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
        ...(aside ? { detail: { text: aside } } : {}),
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
  highlightFindingId = null,
  folded,
}: BlockViewProps): JSX.Element {
  if (block.origin === "system_prompt") {
    return <SystemPromptBlock block={block} />;
  }
  if (block.origin === "workspace") {
    return <WorkspaceBlock block={block} />;
  }
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
    <ThreadLine block={block} ctx={ctx} />
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
        side={side}
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
            <MentionText spans={mentionSpans(block.text, mentionablesOf(ctx))} />
          </div>
        ) : null}
        {body}
        <AttachmentList attachments={block.attachments} ctx={ctx} />
        <DeliveryMeta block={block} ctx={ctx} />
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
      {block.turn ? (
        <TurnAnswer block={block} turn={block.turn} ctx={ctx} folded={folded} />
      ) : block.text ? (
        <Markdown>{block.text}</Markdown>
      ) : null}
      {body}
      <AttachmentList attachments={block.attachments} ctx={ctx} />
      <DeliveryMeta block={block} ctx={ctx} />
      <ReactionBar
        reactions={reactions}
        agentName={author.name}
        onToggle={toggleReaction}
      />
      {threadLine}
    </Post>
  );
});
