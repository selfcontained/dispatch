import { ScheduledMessageEntry } from "./scheduled-message-entry";
import {
  isUserInputBlock,
  isFailedParentInput,
  qualifyExternalMentions,
} from "@dispatch/shared";
import { Link } from "react-router-dom";
import { useJumpToTurn } from "@/hooks/use-block-jump";
import { UserAvatar } from "@/components/app/user-avatar/user-avatar";
import { DeliveryIndicator, DeliveryMeta } from "./chat-delivery-meta";
import { QueuedMessageActions } from "./queued-message-actions";
import { memo, type ReactNode } from "react";
import {
  type Block,
  type BlockAuthor,
  type BlockOption,
  type ChatUserAttachmentInput,
  fileMedia,
} from "@dispatch/shared";
import { MessageSquarePlus, MessagesSquare, Rocket } from "lucide-react";

import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { CopyButton } from "@/components/ui/copy-button";
import { type AgentRelation, agentRelation } from "@/lib/agent-lineage";
import { AgentRelationBadge } from "@/components/app/agent-relation-badge";
import { AgentSeatBadge } from "@/components/app/agent-seat-badge";
import { turnAnswerText } from "@/components/app/chat/turn/answer-text";
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
import { AGENT_TYPE_LABELS, isAgentType } from "@/lib/agent-types";
import { agentTurnLocation } from "@/lib/agent-routes";

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
  /** A running root in another session can also receive a mention. */
  mentionable?: boolean;
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
    Partial<Pick<Agent, "model" | "createdAt" | "status">>)[]
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
      ...(agent.parentAgentId == null && agent.status === "running"
        ? { mentionable: true }
        : {}),
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
  agentId?: string;
  treeRootId?: string;
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
    agentId: ctx.agentId,
    treeRootId: ctx.rootId ?? ctx.agentId,
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
    agentId,
    treeRootId: ctx.rootId ?? ctx.agentId,
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

/** This tree by seat, followed by running roots from other sessions. */
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
    if (peer.seat === undefined && !peer.mentionable) continue;
    list.push({
      id,
      name: peer.name,
      seat: peer.seat,
      agentType: peer.agentType,
    });
  }
  const tree = list.filter((agent) => agent.seat !== undefined);
  const external = list.filter((agent) => agent.seat === undefined);
  return [
    ...tree.sort((a, b) => a.seat! - b.seat!),
    ...qualifyExternalMentions(tree, external),
  ];
}

/** Sent user posts paint their recorded recipients, independent of live eligibility. */
export function historicalMentionablesOf(
  block: Block,
  ctx: FeedContext
): Mentionable[] {
  const ids =
    block.author.kind === "user" && block.kind === "text"
      ? block.data?.mentions
      : undefined;
  if (ids?.length) {
    return ids.map((id) => {
      const name = agentDisplayName(id, ctx);
      const peer = ctx.peers?.[id];
      return {
        id,
        name,
        seat: id === ctx.agentId ? ctx.agentSeat : peer?.seat,
        agentType: id === ctx.agentId ? ctx.agentType : peer?.agentType,
        qualifiedMentionName: `${name.trim()} [${id}]`,
      };
    });
  }
  // Prose without routing metadata retains tree highlighting; unrelated
  // sessions starting later must not change what a historical post means.
  return mentionablesOf(ctx).filter(
    (agent) => agent.id === ctx.agentId || agent.seat !== undefined
  );
}

export function Avatar({ author }: { author: PostAuthor }): JSX.Element {
  const record = useAgentRecord(author.agentId ?? null);
  const seat =
    record?.rootId != null
      ? record.rootId === author.treeRootId
        ? record.seat
        : null
      : (author.seat ?? null);
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
  // Tree numbers describe this session only; external agents share the bot
  // badge and root accent without borrowing a number from another tree.
  return (
    <AgentSeatBadge
      seat={seat}
      name={record?.name ?? author.name}
      title={seat == null ? (record?.name ?? author.name) : undefined}
      aria-label={
        seat == null ? `${record?.name ?? author.name}, agent` : undefined
      }
    />
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

/** Shared display label for a supported engine; null for an unknown one. */
export function agentTypeLabel(type: string | null | undefined): string | null {
  return isAgentType(type) ? AGENT_TYPE_LABELS[type] : null;
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
  return (
    <CopyButton
      text={text}
      label="Copy message"
      copiedLabel="Message copied"
      className={POST_ACTION_BUTTON}
      faceClassName={POST_ACTION_FACE}
      data-testid="chat-copy-message"
    />
  );
}

/**
 * One full-width row of the channel. A header row carries the avatar, the
 * author and the time; a grouped row (same author, shortly after) keeps only
 * the body, and shows the time in the gutter on hover. Delivery-tracked
 * grouped rows keep a compact time-and-receipt anchor without repeating
 * the author metadata; its reserved slot does not move as receipts fade.
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
  deliveryIndicator,
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
  /** A receipt after the timestamp, with a fixed slot that preserves header layout. */
  deliveryIndicator?: ReactNode;
  /**
   * No avatar gutter and a narrower inset: for a card that is the whole
   * subject of a narrow panel (a review in the drawer) and wants the width.
   */
  flush?: boolean;
  children: ReactNode;
  [dataAttr: `data-${string}`]: string | undefined;
}): JSX.Element {
  const timestamp = (
    <span className="inline-flex shrink-0 items-center gap-1">
      <span
        className="text-[11px] text-muted-foreground"
        title={formatDateTime(at)}
        data-testid="chat-post-time"
      >
        {clockTime(at)}
      </span>
      {deliveryIndicator ? (
        <span
          className="flex h-4 w-4 shrink-0 items-center"
          data-testid="chat-delivery-slot"
        >
          {deliveryIndicator}
        </span>
      ) : null}
    </span>
  );
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
            deliveryIndicator ? null : (
              <span
                className="invisible whitespace-nowrap pt-1 text-[10px] leading-none text-muted-foreground group-hover:visible"
                title={formatDateTime(at)}
                data-testid="chat-gutter-time"
              >
                {gutterTime(at)}
              </span>
            )
          ) : (
            <Avatar author={author} />
          )}
        </div>
      )}
      <div className="min-w-0 flex-1 after:block after:clear-both after:content-['']">
        {/* Actions share the author row. The body clears this float so even
            grouped posts and overflow-contained markdown get the full width. */}
        {action && !flush ? (
          <div
            className="float-right ml-2 max-sm:-mr-2 max-sm:-mt-2 [@media(pointer:coarse)]:-mr-2 [@media(pointer:coarse)]:-mt-2"
            data-testid="chat-post-action"
          >
            {action}
          </div>
        ) : null}
        {grouped ? (
          deliveryIndicator ? (
            <div
              className="flex items-center leading-tight"
              data-testid="chat-grouped-receipt-header"
            >
              {timestamp}
            </div>
          ) : null
        ) : (
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
            {timestamp}
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
            "clear-both min-w-0 text-sm text-foreground",
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
  return (
    <AgentSeatBadge
      seat={seat ?? null}
      name={name}
      title={seat === undefined ? name : undefined}
      size="sm"
      className={ring}
      data-testid="chat-thread-replier"
    />
  );
}

/** Keep a request's words and controls together, retaining a quiet receipt rail. */
function InputSurface({
  block,
  children,
}: {
  block: Block;
  children: ReactNode;
}): JSX.Element {
  if (block.kind !== "question" && block.kind !== "form")
    return <>{children}</>;
  const resolved = Boolean(
    block.state?.cancellation ||
    (block.kind === "question"
      ? block.state?.answer !== undefined
      : block.state?.submission !== undefined)
  );
  return (
    <div
      data-testid="chat-input-surface"
      data-state={resolved ? "resolved" : "open"}
      className={cn(
        "min-w-0 rounded-r-md border-l-[3px] px-3 py-2",
        resolved
          ? "border-border bg-transparent"
          : "border-primary bg-primary/5"
      )}
    >
      {children}
    </div>
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
  onAnswer: (
    blockId: string,
    option: BlockOption,
    attachments?: ChatUserAttachmentInput[]
  ) => void;
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
  const recovery = isFailedParentInput(block);
  switch (block.kind) {
    case "question":
      return (
        <QuestionOptions
          block={block}
          answering={answering}
          answersDisabled={
            !recovery && (answersDisabled || block.data.parentHandled === true)
          }
          canceling={ctx.settingBlockStateId === block.id}
          onAnswer={(option, attachments) =>
            onAnswer(block.id, option, attachments)
          }
          onCancel={cancelAsk}
        />
      );
    case "form":
      return (
        <FormBlockBody
          block={block}
          submitting={submitting}
          disabled={
            !onSubmitForm ||
            (!recovery &&
              (answersDisabled || block.data.parentHandled === true))
          }
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
      return <CompactLaunchCard block={block} ctx={ctx} inThread={inThread} />;
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
  onAnswer: (
    blockId: string,
    option: BlockOption,
    attachments?: ChatUserAttachmentInput[]
  ) => void;
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
          <InputSurface block={item}>
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
          </InputSurface>
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
  onAnswer: (
    blockId: string,
    option: BlockOption,
    attachments?: ChatUserAttachmentInput[]
  ) => void;
  /** Inside a thread page: no reply line, no thread to open. */
  inThread?: boolean;
  /** The thread page this is drawn on, when it is one. */
  threadRoot?: string | null;
  /** A review's finding to pick out (the panel's `?finding=`). */
  highlightFindingId?: string | null;
  /** A turn block only: what the agent produced while the turn ran, folded under its answer. */
  folded?: readonly FoldedEntry[];
};

function CompactLaunchCard({
  block,
  ctx,
  inThread,
}: {
  block: Extract<Block, { kind: "launch" }>;
  ctx: FeedContext;
  inThread: boolean;
}): JSX.Element {
  const agent = useAgentRecord(block.toAgentId);
  const name = agent?.name || agentDisplayName(block.toAgentId ?? "", ctx);
  const type = agent?.type ?? ctx.peers?.[block.toAgentId ?? ""]?.agentType;
  const model = agent?.model ?? ctx.peers?.[block.toAgentId ?? ""]?.model;
  const engine = type && isAgentType(type) ? AGENT_TYPE_LABELS[type] : type;
  return (
    <div
      className="mx-3 my-4 sm:mx-4 sm:my-[18px]"
      data-testid="chat-compact-launch"
      data-block-id={block.id}
    >
      <div
        className="flex min-w-0 items-center justify-center gap-2 sm:gap-3.5"
        data-testid="launch-agent-details"
      >
        <span className="h-px min-w-0 flex-1 bg-border" aria-hidden="true" />
        <AgentSeatBadge
          seat={
            agent?.seat ??
            (block.toAgentId === ctx.agentId
              ? (ctx.agentSeat ?? null)
              : (ctx.peers?.[block.toAgentId ?? ""]?.seat ?? null))
          }
          name={name}
          size="sm"
          className="h-[26px] w-[26px]"
        />
        <div className="min-w-0 max-w-[calc(100%-4rem)]">
          <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap leading-[21px] sm:gap-2">
            <span className="text-[10px] font-normal uppercase tracking-[0.065em] text-emerald-300/70">
              Launched
            </span>
            <span className="truncate text-xs font-medium" title={name}>
              {name}
            </span>
            {engine ? (
              <span className="text-[11px] text-muted-foreground">
                {engine}
              </span>
            ) : null}
            {model ? (
              <span className="truncate text-xs font-medium" title={model}>
                {ctx.modelLabel?.(type ?? null, model) ?? model}
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 items-center justify-between gap-3.5 whitespace-nowrap text-[11px] leading-[21px] text-muted-foreground">
            {agent?.persona ? (
              <span className="truncate" title={agent.persona}>
                {agent.persona}
              </span>
            ) : null}
            <time
              className="shrink-0 text-[10px]"
              dateTime={block.createdAt}
              title={formatDateTime(block.createdAt)}
            >
              {clockTime(block.createdAt)}
            </time>
          </div>
        </div>
        {!inThread && ctx.onOpenThread ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-auto shrink-0 px-2 py-1 text-xs"
            data-testid="launch-open-thread"
            onClick={() => ctx.onOpenThread?.(block.id)}
            aria-label={`Open launch thread for ${name}`}
          >
            <MessagesSquare className="mr-1 h-3.5 w-3.5" />
            {block.replyCount
              ? `${block.replyCount} ${block.replyCount === 1 ? "reply" : "replies"}`
              : "Details"}
          </Button>
        ) : null}
        <span className="h-px min-w-0 flex-1 bg-border" aria-hidden="true" />
      </div>
      {inThread ? (
        <div className="mt-4 space-y-4" data-testid="launch-briefing">
          {block.text ? (
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Prompt
              </p>
              <Markdown>{block.text}</Markdown>
            </div>
          ) : null}
          <AttachmentList block={block} ctx={ctx} />
          {block.state?.instructions ? (
            <details>
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                Instructions
              </summary>
              <div className="mt-2">
                <Markdown>{block.state.instructions}</Markdown>
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
      {block.blocks
        ?.filter((item) => item.kind === "review")
        .map((review) => (
          <div
            key={review.id}
            className="mt-3 sm:mx-8"
            data-testid="compact-launch-review"
          >
            <ReviewBlockBody
              block={review}
              compact={!inThread}
              defaultExpanded={inThread}
              onOpen={
                ctx.onOpenThread
                  ? () => ctx.onOpenThread?.(review.id)
                  : undefined
              }
              onOpenFinding={
                ctx.onOpenThread
                  ? (findingId) => ctx.onOpenThread?.(review.id, findingId)
                  : undefined
              }
              onOpenPath={ctx.onOpenPath}
            />
          </div>
        ))}
    </div>
  );
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
  const mirroredInput =
    !inThread &&
    block.threadId !== null &&
    (isUserInputBlock(block) || isFailedParentInput(block));
  const replyAction =
    !inThread && ctx.onOpenThread ? (
      <ReplyInThreadButton
        onClick={() =>
          ctx.onOpenThread?.(mirroredInput ? block.threadId! : block.id)
        }
      />
    ) : null;
  const copyText = block.turn ? turnAnswerText(block, block.turn) : block.text;
  const copyAction =
    copyText || replyAction ? (
      <div className="flex items-center">
        {replyAction}
        {copyText ? <MessageCopyButton text={copyText} /> : null}
      </div>
    ) : undefined;
  const settledParentRequest =
    (block.kind === "question" || block.kind === "form") &&
    block.data.parentHandled === true &&
    (block.kind === "question"
      ? !!block.state?.answer
      : !!block.state?.submission);
  const deliveryIndicator =
    !settledParentRequest &&
    block.toAgentId &&
    block.delivery?.length &&
    block.kind !== "launch" ? (
      <DeliveryIndicator block={block} />
    ) : undefined;
  const reactions = block.reactions ?? [];
  const threadLine = inThread ? null : <ThreadLine block={block} ctx={ctx} />;
  // The thread this post opens onto: its own, or the one it is drawn in.
  const threadRootId = threadRoot ?? block.id;
  const failedRequest = isFailedParentInput(block);
  const failedRecipient =
    block.inputReply?.delivered === false
      ? block.inputReply.toAgentId
      : block.toAgentId;
  const failureNotice =
    failedRequest && failedRecipient ? (
      <p
        className="mb-2 text-sm text-destructive"
        role="status"
        data-testid="parent-request-delivery-failure"
      >
        {block.inputReply?.delivered === false
          ? `Couldn’t deliver the answer to ${agentDisplayName(failedRecipient, ctx)}. You can retry delivery or ask the parent for help.`
          : `Couldn’t deliver this request to ${agentDisplayName(failedRecipient, ctx)}. You can answer it here or ask the parent to handle it.`}
      </p>
    ) : null;
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
      {block.inputReply ? (
        <>
          <AttachmentList block={block.inputReply} ctx={ctx} />
          <DeliveryMeta
            block={block.inputReply}
            recipientName={(id) => agentDisplayName(id, ctx)}
            retrying={ctx.retrying?.has(block.inputReply.id)}
            onRetryDelivery={ctx.onRetryDelivery}
          />
          {block.inputReply.delivered === null &&
          block.inputReply.delivery?.some((entry) => entry.state === "held") ? (
            <QueuedMessageActions
              agentId={block.inputReply.streamId}
              messageId={block.inputReply.id}
              recipientIds={block.inputReply.delivery
                .filter((entry) => entry.state === "held")
                .map((entry) => entry.agentId)}
              threadId={
                block.inputReply.kind === "text"
                  ? block.inputReply.data?.inlineAnswerConversation?.threadId
                  : undefined
              }
              requiresNextTurn={block.inputReply.attachments.some(
                (attachment) =>
                  attachment.type === "file" &&
                  fileMedia(attachment.mimeType) === "image"
              )}
              canSendNow={
                block.inputReply.kind === "text" &&
                !!block.inputReply.data?.inlineAnswerConversation &&
                block.inputReply.data?.delivery !== "interrupt"
              }
            />
          ) : null}
        </>
      ) : null}
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

  if (block.kind === "launch") {
    return <CompactLaunchCard block={block} ctx={ctx} inThread={inThread} />;
  }

  // A person's block, whoever it reads as: a launch-context post made by
  // another agent keeps the user-post layout under that agent's name.
  if (block.author.kind === "user") {
    const queued =
      block.delivered === null &&
      block.toAgentId &&
      !block.origin &&
      block.delivery?.some((entry) => entry.state === "held");
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
        deliveryIndicator={deliveryIndicator}
      >
        {block.text ? (
          <Markdown
            className="prose-p:whitespace-pre-line prose-li:whitespace-pre-line"
            renderText={(text) => (
              <MentionText
                spans={mentionSpans(text, historicalMentionablesOf(block, ctx))}
              />
            )}
          >
            {block.text}
          </Markdown>
        ) : null}
        {body}
        <AttachmentList block={block} ctx={ctx} />
        {/* Queue/failure actions are persistent callouts. Transient receipt
            feedback stays after the timestamp. */}
        <div
          className={cn(
            "min-w-0",
            queued &&
              "mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1"
          )}
        >
          <div className={cn("min-w-0", queued && "[&>div]:mt-0")}>
            <DeliveryMeta
              block={block}
              recipientName={(id) => agentDisplayName(id, ctx)}
              retrying={ctx.retrying?.has(block.id)}
              onRetryDelivery={ctx.onRetryDelivery}
            />
          </div>
          {queued ? (
            <QueuedMessageActions
              agentId={block.streamId}
              messageId={block.id}
              recipientIds={block.delivery
                ?.filter((entry) => entry.state === "held")
                .map((entry) => entry.agentId)}
              threadId={block.threadId}
              requiresNextTurn={block.attachments.some(
                (attachment) =>
                  attachment.type === "file" &&
                  fileMedia(attachment.mimeType) === "image"
              )}
              canSendNow={
                !(
                  block.kind === "text" &&
                  (block.data?.acpCommand ||
                    block.data?.delivery === "interrupt")
                )
              }
            />
          ) : null}
        </div>
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
          <AgentSeatBadge
            seat={author.seat ?? null}
            name={author.name}
            title={author.seat === undefined ? author.name : undefined}
            aria-label={
              author.seat === undefined ? `${author.name}, agent` : undefined
            }
            size="sm"
          />
        }
      />
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
      data-testid="chat-message"
      data-author={author.kind === "peer" ? "peer" : "agent"}
      data-kind={block.kind}
      data-origin={block.origin}
      data-to-agent={block.toAgentId ?? undefined}
      data-block-id={block.id}
      action={agentAction}
      deliveryIndicator={deliveryIndicator}
    >
      {mirroredInput ? (
        <SourceMessageLink
          block={block}
          agentId={ctx.agentId ?? block.streamId}
        />
      ) : null}
      {block.kind === "text" && block.data?.responseTo?.length ? (
        <ResponseBacklink
          agentId={
            block.author.kind === "agent"
              ? block.author.agentId
              : block.streamId
          }
          blockId={block.data.responseTo[block.data.responseTo.length - 1]!}
          threadId={
            block.data.responseToThreadId !== undefined
              ? block.data.responseToThreadId
              : block.threadId
          }
          multiple={block.data.responseTo.length > 1}
        />
      ) : null}
      {failureNotice}
      <InputSurface block={block}>
        {block.turn ? (
          <TurnAnswer
            block={block}
            turn={block.turn}
            ctx={ctx}
            folded={folded}
          />
        ) : block.author.kind === "agent" &&
          typeof (block.data as { scheduledMessageId?: unknown } | null)
            ?.scheduledMessageId === "string" ? (
          <ScheduledMessageEntry
            agentId={block.author.agentId}
            scheduleId={
              (block.data as { scheduledMessageId: string }).scheduledMessageId
            }
            delivery={block.toAgentId !== null}
            deliveryStatus={
              block.kind === "text" &&
              typeof block.data?.scheduledDeliveryStatus === "string"
                ? block.data.scheduledDeliveryStatus
                : undefined
            }
            fallbackText={block.text ?? ""}
            presentation={
              (
                block.data as {
                  scheduledMessage?: import("@dispatch/shared").ScheduledMessagePresentation;
                }
              ).scheduledMessage
            }
          />
        ) : block.text ? (
          <Markdown
            renderText={(text) => (
              <MentionText
                spans={mentionSpans(text, historicalMentionablesOf(block, ctx))}
              />
            )}
          >
            {block.text}
          </Markdown>
        ) : null}
        {body}
      </InputSurface>
      <AttachmentList block={block} ctx={ctx} />
      {!settledParentRequest && (
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

function ResponseBacklink({
  agentId,
  blockId,
  threadId,
  multiple,
}: {
  agentId: string;
  blockId: string;
  threadId: string | null;
  multiple: boolean;
}) {
  const jumpToTurn = useJumpToTurn();
  const turn = { blockId, threadId };
  return (
    <Link
      className="mb-1 inline-block text-[11px] text-muted-foreground hover:underline"
      to={agentTurnLocation(agentId, turn)}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        jumpToTurn(agentId, turn);
      }}
    >
      In response to your {multiple ? "messages" : "message"}
    </Link>
  );
}

/** Open the containing thread on the exact message, including repeated clicks. */
function SourceMessageLink({
  block,
  agentId,
}: {
  block: Block;
  agentId: string;
}) {
  const jump = useJumpToTurn();
  const target = { blockId: block.id, threadId: block.threadId };
  return (
    <Link
      data-testid="chat-input-source"
      className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
      to={agentTurnLocation(agentId, target)}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        jump(agentId, target);
      }}
    >
      <MessagesSquare className="h-3 w-3" aria-hidden="true" />
      Open original message
    </Link>
  );
}
