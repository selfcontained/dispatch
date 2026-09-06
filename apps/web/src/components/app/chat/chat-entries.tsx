import { memo, type ReactNode } from "react";
import type {
  ChatAgentMessageEntry,
  ChatAttachment,
  ChatMediaEntry,
  ChatMessage,
  ChatPinEntry,
  ChatQuestionOption,
  ChatReviewEntry,
  ChatStatusEntry,
} from "@dispatch/shared";
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  Copy,
  ExternalLink,
  FileText,
  GitPullRequest,
  Hourglass,
  Loader2,
  Pin,
  Rocket,
  UserRound,
} from "lucide-react";

import {
  latestEventColor,
  latestEventLabel,
} from "@/components/app/agent-event-utils";
import { AgentRelationBadge } from "@/components/app/agent-relation-badge";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { PinItem } from "@/components/app/pin-item";
import {
  reviewerLabel,
  ReviewSummaryBlock,
} from "@/components/app/review-summary-block";
import { type Agent, type AgentPin } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { useCopyText } from "@/hooks/use-copy";
import { formatBytes } from "@/components/app/service-resources-format";
import { type AgentRelation, agentRelation } from "@/lib/agent-lineage";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { isImageFile } from "../../../../../server/src/shared/media-file-types";

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

function mediaFileUrl(agentId: string, fileName: string): string {
  return `/api/v1/agents/${agentId}/media/${encodeURIComponent(fileName)}`;
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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
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

/** What every row of the channel needs to know about the agent it belongs to. */
export type FeedContext = {
  agentId: string;
  /** The agent this channel belongs to; names its posts. */
  agentName?: string;
  agentType?: string | null;
  /** Other agents, for a peer post's avatar and relation; absent until loaded. */
  peers?: PeerDirectory;
  pins: AgentPin[];
  workspaceRoot: string | null;
  /**
   * Fires a shortcut pin shown in the feed, the same way the sidebar does.
   * Absent (agent history, tests) renders shortcuts inert.
   */
  onRunShortcut?: (pin: AgentPin, pointerType?: string) => void;
  /** The shortcut whose run is in flight; its button stays disabled. */
  pendingPinId?: string | null;
  /** Off when the agent cannot receive a shortcut (stopped, archived). */
  agentIsRunning?: boolean;
  onOpenMedia: (mediaId: number) => void;
  /** Opens a review in the Reviews sidebar, expanded. */
  onOpenReview?: (reviewId: number) => void;
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

function agentAuthor(ctx: FeedContext, fallback = ""): PostAuthor {
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
function peerAuthor(
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
 * Who a user post reads as. A launch-context post made by another agent
 * (dispatch_launch_agent) is that agent's, named from the agents list when
 * it is still there and "Agent" otherwise; every other user post is "You".
 */
export function chatMessageAuthor(
  message: ChatMessage,
  ctx: FeedContext
): PostAuthor {
  if (message.authorKind !== "user") return agentAuthor(ctx, "Agent");
  if (message.launchedByAgentId) {
    const peer = ctx.peers?.[message.launchedByAgentId];
    return peerAuthor(message.launchedByAgentId, peer?.name ?? "Agent", ctx);
  }
  return userAuthor();
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
export const SIDE_POST_INDENT = "pl-[3.75rem]";

/** A post-local clipboard action with the same confirmation used elsewhere. */
function MessageCopyButton({ text }: { text: string }): JSX.Element {
  const [copied, copyText] = useCopyText();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        "h-7 w-7 p-0 hover:bg-transparent",
        "max-sm:h-11 max-sm:w-11 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11",
        "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
        "max-sm:opacity-100 [@media(pointer:coarse)]:opacity-100",
        copied && "opacity-100 text-status-working"
      )}
      onClick={() => copyText(text)}
      title={copied ? "Copied" : "Copy message"}
      aria-label={copied ? "Message copied" : "Copy message"}
      data-testid="chat-copy-message"
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background/90 shadow-sm">
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
  children: ReactNode;
  [dataAttr: `data-${string}`]: string | undefined;
}): JSX.Element {
  return (
    <div
      className={cn(
        "group relative flex min-w-0 max-w-full gap-3 transition-colors",
        side ? cn(SIDE_POST_INDENT, "pr-4") : "px-4",
        side ? POST_TINT.peer : POST_TINT[author.kind],
        grouped ? "py-1" : "mt-3 pb-1.5 pt-2",
        rule && "border-t border-border/40"
      )}
      data-grouped={grouped ? "true" : undefined}
      data-group-start={grouped ? undefined : "true"}
      data-author-kind={author.kind}
      data-rule={rule ? "true" : undefined}
      data-side={side ? "true" : undefined}
      {...rest}
    >
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
      <div className="min-w-0 flex-1 after:block after:clear-both after:content-['']">
        {action ? (
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
            {author.kind === "peer" ? (
              <AgentRelationBadge relation={author.relation ?? "agent"} />
            ) : null}
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
// Attachments
// ---------------------------------------------------------------------------

/** The left-accented block Slack hangs under a post. */
function AttachmentBlock({
  children,
  className,
  accent = "border-border",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  accent?: string;
  [dataAttr: `data-${string}`]: string | undefined;
}): JSX.Element {
  return (
    <div
      className={cn("border-l-[3px] py-0.5 pl-3", accent, className)}
      {...rest}
    >
      {children}
    </div>
  );
}

function LinkAttachment({
  href,
  title,
  icon,
  testId,
}: {
  href: string;
  title: string | undefined;
  icon: JSX.Element;
  testId: string;
}): JSX.Element {
  const host = hostOf(href);
  return (
    <AttachmentBlock data-testid={testId}>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="group/link flex min-w-0 items-start gap-2"
        title={href}
      >
        <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground underline-offset-2 group-hover/link:underline">
            {title ?? href}
          </span>
          {title && host ? (
            <span className="block truncate text-[11px] text-muted-foreground">
              {host}
            </span>
          ) : null}
        </span>
      </a>
    </AttachmentBlock>
  );
}

function FileAttachment({
  attachment,
  ctx,
}: {
  attachment: Extract<ChatAttachment, { type: "file" }>;
  ctx: FeedContext;
}): JSX.Element {
  const url = mediaFileUrl(ctx.agentId, attachment.fileName);
  const open = () => ctx.onOpenMedia(attachment.mediaId);
  // By stored name or by the media row's type: a file shared without an
  // extension still renders as the image it is.
  const isImage =
    isImageFile(attachment.fileName) ||
    (attachment.mimeType?.startsWith("image/") ?? false);
  if (isImage) {
    return (
      <AttachmentBlock data-testid="chat-attachment-image">
        <div className="mb-1 truncate text-[11px] text-muted-foreground">
          {attachment.fileName} · {formatBytes(attachment.sizeBytes)}
        </div>
        <button
          type="button"
          onClick={open}
          className="block max-w-xs overflow-hidden rounded-md border border-border bg-background/60 text-left transition-colors hover:border-foreground/30"
          title={attachment.fileName}
        >
          {/*
           * A fixed height, not a max: the image is lazy, so a box that
           * sized itself to the file would be 0px until the image arrives
           * and then shove everything below it down — which is what pushes
           * a reader off the message they were on. Letterboxing a short
           * image is the cheaper cost.
           */}
          <img
            src={url}
            alt={attachment.fileName}
            className="h-56 w-full bg-muted/30 object-scale-down"
            loading="lazy"
          />
        </button>
      </AttachmentBlock>
    );
  }
  return (
    <AttachmentBlock data-testid="chat-attachment-file">
      <button
        type="button"
        onClick={open}
        className="flex min-w-0 max-w-full items-start gap-2 text-left"
        title={attachment.fileName}
      >
        <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-foreground">
            {attachment.fileName}
          </span>
          <span className="block text-[11px] text-muted-foreground">
            {formatBytes(attachment.sizeBytes)}
          </span>
        </span>
      </button>
    </AttachmentBlock>
  );
}

function CodeAttachment({
  attachment,
}: {
  attachment: Extract<ChatAttachment, { type: "code" }>;
}): JSX.Element {
  const fence = "```";
  const source = `${fence}${attachment.language ?? ""}\n${attachment.code}\n${fence}`;
  return (
    <AttachmentBlock data-testid="chat-attachment-code">
      {attachment.path ? (
        <div className="mb-1 truncate font-mono text-[11px] text-muted-foreground">
          {attachment.path}
        </div>
      ) : null}
      <Markdown className="text-xs">{source}</Markdown>
    </AttachmentBlock>
  );
}

/**
 * A pin rendered live from the agent's current pins — the sidebar's own
 * `PinItem`, so the stream and the sidebar never disagree, and a shortcut
 * fires from either place. `label` names a pin that is no longer there.
 */
function LivePin({
  pinId,
  label,
  ctx,
  testId,
}: {
  pinId: string;
  label?: string;
  ctx: FeedContext;
  testId: string;
}): JSX.Element {
  const pin = ctx.pins.find((p) => p.id === pinId);
  if (!pin) {
    return (
      <AttachmentBlock
        className="text-xs italic text-muted-foreground"
        data-testid={`${testId}-missing`}
      >
        {label ? (
          <>
            <span className="not-italic font-medium">{label}</span> · pin no
            longer available
          </>
        ) : (
          "Pin no longer available"
        )}
      </AttachmentBlock>
    );
  }
  // A card rather than the accent bar the other attachments use: a pin's
  // copy button sits at the right edge of its own box, and without a drawn
  // edge that box is invisible — the button reads as floating somewhere
  // short of where the post's copy action lives. A shortcut is already a
  // button, so it gets no card; it is a sidebar-width button (w-full) that
  // in the channel's wide measure would stretch into a banner, so it is
  // capped instead.
  return (
    <div
      className={
        pin.type === "shortcut"
          ? "max-w-[14rem]"
          : "max-w-md rounded-md border border-border bg-card/60 px-3 py-2"
      }
      data-testid={testId}
    >
      <PinItem
        pin={pin}
        workspaceRoot={ctx.workspaceRoot}
        inGroup
        agentIsRunning={ctx.agentIsRunning ?? true}
        onRunShortcut={ctx.onRunShortcut}
        pendingPinId={ctx.pendingPinId ?? null}
        agentName={ctx.agentName ?? null}
      />
    </div>
  );
}

function PinAttachment({
  attachment,
  ctx,
}: {
  attachment: Extract<ChatAttachment, { type: "pin" }>;
  ctx: FeedContext;
}): JSX.Element {
  return (
    <LivePin pinId={attachment.pinId} ctx={ctx} testId="chat-attachment-pin" />
  );
}

function AttachmentView({
  attachment,
  ctx,
}: {
  attachment: ChatAttachment;
  ctx: FeedContext;
}): JSX.Element {
  switch (attachment.type) {
    case "file":
      return <FileAttachment attachment={attachment} ctx={ctx} />;
    case "link":
      return (
        <LinkAttachment
          href={attachment.url}
          title={attachment.title}
          icon={<ExternalLink className="h-3.5 w-3.5" />}
          testId="chat-attachment-link"
        />
      );
    case "pr":
      return (
        <LinkAttachment
          href={attachment.url}
          title={attachment.title}
          icon={<GitPullRequest className="h-3.5 w-3.5" />}
          testId="chat-attachment-pr"
        />
      );
    case "code":
      return <CodeAttachment attachment={attachment} />;
    case "pin":
      return <PinAttachment attachment={attachment} ctx={ctx} />;
  }
}

function AttachmentList({
  attachments,
  ctx,
}: {
  attachments: ChatAttachment[];
  ctx: FeedContext;
}): JSX.Element | null {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {attachments.map((attachment, index) => (
        <AttachmentView key={index} attachment={attachment} ctx={ctx} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

function QuestionOptions({
  message,
  answering,
  answersDisabled,
  onAnswer,
}: {
  message: ChatMessage;
  /** This question's answer is in flight. */
  answering: boolean;
  /** Nothing can be sent right now, so neither buttons nor a typed reply. */
  answersDisabled: boolean;
  onAnswer: (option: ChatQuestionOption) => void;
}): JSX.Element | null {
  const question = message.question;
  if (!question) return null;
  const answer = message.answer;
  const open = answer === null;
  const optionsDisabled = answer !== null || answering || answersDisabled;
  return (
    <div
      className={cn(
        "mt-2 rounded-md border p-3",
        open
          ? "border-status-waiting/50 bg-status-waiting/[0.07]"
          : "border-border bg-muted/30"
      )}
      data-testid="chat-question-options"
    >
      {open ? (
        <div
          className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-status-waiting"
          data-testid="chat-needs-reply"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          Needs your reply
        </div>
      ) : (
        <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Check className="h-3 w-3" />
          Answered
          <span className="truncate">· {answer.label ?? answer.value}</span>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {question.options.map((option, index) => {
          const value = option.value ?? option.label;
          const chosen = answer !== null && answer.value === value;
          return (
            <Button
              key={`${index}-${value}`}
              type="button"
              size="sm"
              variant={chosen ? "primary" : "default"}
              className={cn(
                "h-7 gap-1 text-xs",
                // Phones and touch screens: a real tap target, with the label
                // allowed to wrap instead of being clipped.
                "max-sm:h-auto max-sm:min-h-11 max-sm:whitespace-normal max-sm:py-2 max-sm:text-left",
                "[@media(pointer:coarse)]:h-auto [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:whitespace-normal [@media(pointer:coarse)]:py-2 [@media(pointer:coarse)]:text-left",
                chosen && "cursor-default"
              )}
              disabled={optionsDisabled}
              aria-pressed={chosen}
              data-testid="chat-question-option"
              onClick={() => onAnswer(option)}
            >
              {chosen ? <Check className="h-3 w-3" /> : null}
              {option.label}
            </Button>
          );
        })}
      </div>
      {open && question.allowFreeform && !answersDisabled ? (
        <div className="mt-2 text-[11px] text-muted-foreground">
          Or type a reply below.
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

/** Delivery state of a user post; nothing once it has landed. */
function DeliveryMeta({
  message,
  held,
}: {
  message: ChatMessage;
  held: boolean;
}): JSX.Element | null {
  if (message.authorKind !== "user") return null;
  if (held) {
    return (
      <div
        className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground"
        title="Dispatch is holding this message until you pause typing in the Console."
        data-testid="chat-held-hint"
      >
        <Hourglass className="h-3 w-3" />
        Waiting to deliver
      </div>
    );
  }
  if (message.delivered === false) {
    return (
      <div
        className="mt-1 inline-flex items-center gap-1 text-[11px] text-destructive"
        title="The agent had no terminal to receive this message."
        data-testid="chat-delivery-failed"
      >
        <AlertTriangle className="h-3 w-3" />
        Not delivered
      </div>
    );
  }
  if (message.delivered === null) {
    return (
      <div
        className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground"
        title="Delivering to the agent's terminal."
        data-testid="chat-delivery-pending"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Sending
      </div>
    );
  }
  return null;
}

export const ChatMessageView = memo(function ChatMessageView({
  message,
  held,
  grouped,
  rule = false,
  ctx,
  answering,
  answersDisabled = false,
  onAnswer,
}: {
  message: ChatMessage;
  held: boolean;
  grouped: boolean;
  rule?: boolean;
  ctx: FeedContext;
  /** This message's answer is in flight. */
  answering: boolean;
  /** Answers go through the same injection as the composer; lock them together. */
  answersDisabled?: boolean;
  onAnswer: (messageId: string, option: ChatQuestionOption) => void;
}): JSX.Element {
  const copyAction = message.text ? (
    <MessageCopyButton text={message.text} />
  ) : undefined;

  if (message.authorKind === "user") {
    return (
      <Post
        author={chatMessageAuthor(message, ctx)}
        at={message.createdAt}
        grouped={grouped}
        rule={rule}
        data-testid="chat-message"
        data-author="user"
        data-origin={message.origin}
        data-launched-by={message.launchedByAgentId}
        data-message-id={message.id}
        action={copyAction}
      >
        {message.origin === "launch" ? (
          <div
            className="mb-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground"
            title="What this agent was started with — the prompt, files, links and pins from its launch."
            data-testid="chat-launch-context"
          >
            <Rocket className="h-3 w-3" aria-hidden="true" />
            Launch context
          </div>
        ) : null}
        {message.text ? (
          <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {message.text}
          </div>
        ) : null}
        <AttachmentList attachments={message.attachments} ctx={ctx} />
        <DeliveryMeta message={message} held={held} />
      </Post>
    );
  }

  const author = agentAuthor(ctx, "Agent");
  const isQuestion = message.kind === "question";

  if (message.kind === "update") {
    return (
      <Post
        author={author}
        at={message.createdAt}
        grouped={grouped}
        rule={rule}
        data-testid="chat-message"
        data-author="agent"
        data-kind="update"
        data-message-id={message.id}
        action={copyAction}
      >
        <Markdown className="text-muted-foreground prose-p:my-0.5">
          {message.text}
        </Markdown>
        <AttachmentList attachments={message.attachments} ctx={ctx} />
      </Post>
    );
  }

  const body = (
    <>
      <Markdown>{message.text}</Markdown>
      <AttachmentList attachments={message.attachments} ctx={ctx} />
    </>
  );

  return (
    <Post
      author={author}
      at={message.createdAt}
      grouped={grouped}
      rule={rule}
      data-testid="chat-message"
      data-author="agent"
      data-kind={message.kind}
      data-message-id={message.id}
      action={copyAction}
    >
      {message.kind === "summary" ? (
        <AttachmentBlock
          accent="border-status-done/70"
          className="mt-1"
          data-testid="chat-summary"
        >
          <div className="mb-1 text-[11px] font-semibold text-status-done">
            Summary
          </div>
          {body}
        </AttachmentBlock>
      ) : (
        body
      )}
      {isQuestion ? (
        <QuestionOptions
          message={message}
          answering={answering}
          answersDisabled={answersDisabled}
          onAnswer={(option) => onAnswer(message.id, option)}
        />
      ) : null}
    </Post>
  );
});

// ---------------------------------------------------------------------------
// Status, cross-agent messages, media
// ---------------------------------------------------------------------------

/**
 * A quiet system line: smaller and dimmer than a post, its dot tucked into
 * the gutter and its text starting where the gutter ends, so a run of them
 * reads as a seam between posts rather than as posts of its own.
 */
export function StatusLine({
  entry,
  collapsedCount = 1,
}: {
  entry: ChatStatusEntry;
  collapsedCount?: number;
}): JSX.Element {
  const type = asEventType(entry.eventType);
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
}

/**
 * Who an agent-to-agent message reads as. Its group key names both ends of
 * the conversation, so a run of messages between the same two agents
 * collapses under one header while a message to a different agent — or
 * this agent's next post to the user — starts a new one.
 */
export function agentMessageAuthor(
  entry: ChatAgentMessageEntry,
  ctx: FeedContext
): PostAuthor {
  const author =
    entry.direction === "out"
      ? agentAuthor(ctx, entry.senderName)
      : peerAuthor(entry.senderAgentId, entry.senderName, ctx);
  return {
    ...author,
    key: `side:${entry.senderAgentId}>${entry.recipientAgentId}`,
  };
}

export function AgentMessageView({
  entry,
  grouped,
  rule = false,
  ctx,
}: {
  entry: ChatAgentMessageEntry;
  grouped: boolean;
  rule?: boolean;
  ctx: FeedContext;
}): JSX.Element {
  const { delivered } = entry;
  return (
    <Post
      author={agentMessageAuthor(entry, ctx)}
      at={entry.at}
      grouped={grouped}
      rule={rule}
      side={{ recipientName: entry.recipientName }}
      data-testid="chat-agent-message"
      data-direction={entry.direction}
      action={<MessageCopyButton text={entry.content} />}
    >
      <div className="whitespace-pre-wrap break-words">{entry.content}</div>
      {delivered === null ? (
        <div
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground"
          title="Delivering to the recipient agent's terminal."
          data-testid="chat-agent-message-pending"
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          Sending
        </div>
      ) : delivered === false ? (
        <div
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-destructive"
          title="The recipient agent wasn't running, so it never received this message."
        >
          <AlertTriangle className="h-3 w-3" />
          Not delivered
        </div>
      ) : null}
    </Post>
  );
}

export function MediaEntryView({
  entry,
  grouped,
  rule = false,
  ctx,
}: {
  entry: ChatMediaEntry;
  grouped: boolean;
  rule?: boolean;
  ctx: FeedContext;
}): JSX.Element {
  const url = mediaFileUrl(ctx.agentId, entry.fileName);
  const open = () => ctx.onOpenMedia(entry.mediaId);
  const isImage = isImageFile(entry.fileName);
  return (
    <Post
      author={agentAuthor(ctx, "Agent")}
      at={entry.at}
      grouped={grouped}
      rule={rule}
      data-testid="chat-media"
    >
      <AttachmentBlock className="mt-1">
        <button
          type="button"
          onClick={open}
          className="block max-w-full text-left"
          title={entry.fileName}
        >
          <span className="block truncate text-sm font-medium text-foreground">
            {entry.description ?? entry.fileName}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {entry.fileName} · {formatBytes(entry.sizeBytes)}
          </span>
          {isImage ? (
            /* Fixed height for the same reason as FileAttachment's. */
            <img
              src={url}
              alt={entry.description ?? entry.fileName}
              className="mt-1.5 block h-64 w-full max-w-xs rounded-md border border-border bg-muted/30 object-scale-down transition-colors hover:border-foreground/30"
              loading="lazy"
            />
          ) : null}
        </button>
      </AttachmentBlock>
    </Post>
  );
}

/** "Pinned", "Updated pin", "Removed pin" — plural when a batch wrote several. */
export function pinEntryVerb(entry: ChatPinEntry): string {
  const plural = entry.pins.length !== 1;
  switch (entry.action) {
    case "created":
      return plural ? `Pinned ${entry.pins.length} items` : "Pinned";
    case "updated":
      return plural ? `Updated ${entry.pins.length} pins` : "Updated pin";
    case "deleted":
      return plural ? `Removed ${entry.pins.length} pins` : "Removed pin";
  }
}

/**
 * A pin the agent created, updated, or removed, shown at that moment in the
 * stream. The pin itself renders live (see {@link LivePin}): every earlier
 * entry for a pin shows its latest value, so re-reading the channel never
 * shows a stale URL, and a shortcut runs from wherever it appears. A removed
 * pin has nothing left to render, so its entry names it by label only.
 */
export function PinEntryView({
  entry,
  grouped,
  rule = false,
  ctx,
}: {
  entry: ChatPinEntry;
  grouped: boolean;
  rule?: boolean;
  ctx: FeedContext;
}): JSX.Element {
  const removed = entry.action === "deleted";
  return (
    <Post
      author={agentAuthor(ctx, "Agent")}
      at={entry.at}
      grouped={grouped}
      rule={rule}
      data-testid="chat-pin-entry"
      data-pin-action={entry.action}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Pin className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span data-testid="chat-pin-entry-verb">{pinEntryVerb(entry)}</span>
        {removed ? (
          <span className="min-w-0 truncate font-medium text-foreground/80">
            {entry.pins.map((pin) => pin.label).join(", ")}
          </span>
        ) : null}
      </div>
      {removed ? null : (
        <div className="mt-1 flex flex-col gap-2">
          {entry.pins.map((pin) => (
            <LivePin
              key={pin.id}
              pinId={pin.id}
              label={pin.label}
              ctx={ctx}
              testId="chat-pin-entry-pin"
            />
          ))}
        </div>
      )}
    </Post>
  );
}

/**
 * Who a review card reads as: the reviewer agent that submitted it, or the
 * user for a review left by hand in the Changes tab. Its own group key, so
 * a review card never collapses into an adjacent post's header — the card
 * carries its own heading.
 *
 * The name is the server's `reviewerName` (the persona the agent reviewed
 * as, falling back to its own name), which is what the block below the
 * header says too — one actor must not read as two names in one post. The
 * peer directory is only a fallback for a review whose reviewer the list no
 * longer knows.
 */
export function reviewAuthor(
  entry: ChatReviewEntry,
  ctx: FeedContext
): PostAuthor {
  if (entry.reviewerType === "agent" && entry.reviewerAgentId) {
    const peer = ctx.peers?.[entry.reviewerAgentId];
    const author = peerAuthor(
      entry.reviewerAgentId,
      entry.reviewerName ??
        peer?.name ??
        reviewerLabel(entry.reviewerType, entry.reviewerName),
      ctx
    );
    return { ...author, key: `review:${entry.reviewerAgentId}` };
  }
  return { ...userAuthor(), key: "review:human" };
}

/**
 * A review in the channel, as the same block the Reviews sidebar shows for
 * a collapsed review: who left it, how much is still open, its status.
 * Clicking opens that review in the sidebar, where the summary and the
 * feedback items live — the card is the notice, not a second copy of it.
 */
export function ReviewEntryView({
  entry,
  grouped,
  rule = false,
  ctx,
}: {
  entry: ChatReviewEntry;
  grouped: boolean;
  rule?: boolean;
  ctx: FeedContext;
}): JSX.Element {
  const { onOpenReview } = ctx;
  return (
    <Post
      author={reviewAuthor(entry, ctx)}
      at={entry.at}
      grouped={grouped}
      rule={rule}
      data-testid="chat-review"
      data-review-id={String(entry.reviewId)}
    >
      <ReviewSummaryBlock
        review={{
          reviewerType: entry.reviewerType,
          reviewerName: entry.reviewerName,
          status: entry.status,
          itemCount: entry.itemCount,
          resolvedCount: entry.resolvedCount,
          createdAt: entry.at,
        }}
        showTime={false}
        onClick={onOpenReview ? () => onOpenReview(entry.reviewId) : undefined}
        ariaLabel={`Open review from ${reviewerLabel(
          entry.reviewerType,
          entry.reviewerName
        )}`}
        className="mt-1 max-w-sm"
        data-testid="chat-review-block"
      />
    </Post>
  );
}
