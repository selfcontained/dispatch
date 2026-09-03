import { memo, type ReactNode } from "react";
import type {
  ChatAgentMessageEntry,
  ChatAttachment,
  ChatMediaEntry,
  ChatMessage,
  ChatQuestionOption,
  ChatStatusEntry,
} from "@dispatch/shared";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  FileText,
  GitPullRequest,
  Hourglass,
  Loader2,
  UserRound,
} from "lucide-react";

import {
  latestEventColor,
  latestEventLabel,
} from "@/components/app/agent-event-utils";
import { AgentTypeIcon } from "@/components/app/agent-type-icon";
import { PinItem } from "@/components/app/pin-item";
import { type AgentPin, type MediaFile } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { formatBytes } from "@/components/app/service-resources-format";
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

/** What every row of the channel needs to know about the agent it belongs to. */
export type FeedContext = {
  agentId: string;
  /** The agent this channel belongs to; names its posts. */
  agentName?: string;
  agentType?: string | null;
  pins: AgentPin[];
  workspaceRoot: string | null;
  onOpenMedia: (file: MediaFile) => void;
};

export type PostAuthor = {
  /** Consecutive posts with the same key can collapse under one header. */
  key: string;
  name: string;
  kind: "user" | "agent" | "peer";
  agentType?: string | null;
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

function peerAuthor(agentId: string, name: string): PostAuthor {
  return { key: `peer:${agentId}`, name, kind: "peer" };
}

const AVATAR_ICON = "[&>svg]:h-[18px] [&>svg]:w-[18px]";

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
  return (
    <AgentTypeIcon
      type={author.kind === "agent" ? author.agentType : null}
      className={cn("h-8 w-8 rounded-md", AVATAR_ICON)}
    />
  );
}

/**
 * One full-width row of the channel. A header row carries the avatar, the
 * author and the time; a grouped row (same author, shortly after) keeps only
 * the body, and shows the time in the gutter on hover.
 */
export function Post({
  author,
  at,
  grouped,
  children,
  ...rest
}: {
  author: PostAuthor;
  at: string;
  grouped: boolean;
  children: ReactNode;
  [dataAttr: `data-${string}`]: string | undefined;
}): JSX.Element {
  return (
    <div
      className={cn(
        "group relative flex gap-3 px-4 transition-colors hover:bg-muted/40",
        grouped ? "py-0.5" : "mt-2 pb-0.5 pt-1.5"
      )}
      data-grouped={grouped ? "true" : undefined}
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
          <Avatar author={author} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {grouped ? null : (
          <div className="flex items-baseline gap-2 leading-tight">
            <span
              className="truncate text-sm font-semibold text-foreground"
              data-testid="chat-post-author"
            >
              {author.name}
            </span>
            <span
              className="shrink-0 text-[11px] text-muted-foreground"
              title={formatDateTime(at)}
            >
              {clockTime(at)}
            </span>
          </div>
        )}
        <div className="text-sm text-foreground">{children}</div>
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
  at,
  ctx,
}: {
  attachment: Extract<ChatAttachment, { type: "file" }>;
  at: string;
  ctx: FeedContext;
}): JSX.Element {
  const url = mediaFileUrl(ctx.agentId, attachment.fileName);
  const open = () =>
    ctx.onOpenMedia({
      // ownerAgentId is part of the lightbox identity; without it the
      // synthesized file never matches the media list and nothing opens.
      ownerAgentId: ctx.agentId,
      name: attachment.fileName,
      size: attachment.sizeBytes,
      updatedAt: at,
      url,
    });
  if (isImageFile(attachment.fileName)) {
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
          <img
            src={url}
            alt={attachment.fileName}
            className="max-h-56 w-full object-contain"
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

function PinAttachment({
  attachment,
  ctx,
}: {
  attachment: Extract<ChatAttachment, { type: "pin" }>;
  ctx: FeedContext;
}): JSX.Element {
  const pin = ctx.pins.find((p) => p.id === attachment.pinId);
  if (!pin) {
    return (
      <AttachmentBlock
        className="text-xs italic text-muted-foreground"
        data-testid="chat-attachment-pin-missing"
      >
        Pin no longer available
      </AttachmentBlock>
    );
  }
  return (
    <AttachmentBlock data-testid="chat-attachment-pin">
      <PinItem pin={pin} workspaceRoot={ctx.workspaceRoot} inGroup />
    </AttachmentBlock>
  );
}

function AttachmentView({
  attachment,
  at,
  ctx,
}: {
  attachment: ChatAttachment;
  at: string;
  ctx: FeedContext;
}): JSX.Element {
  switch (attachment.type) {
    case "file":
      return <FileAttachment attachment={attachment} at={at} ctx={ctx} />;
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
  at,
  ctx,
}: {
  attachments: ChatAttachment[];
  at: string;
  ctx: FeedContext;
}): JSX.Element | null {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {attachments.map((attachment, index) => (
        <AttachmentView key={index} attachment={attachment} at={at} ctx={ctx} />
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
  ctx,
  answering,
  answersDisabled = false,
  onAnswer,
}: {
  message: ChatMessage;
  held: boolean;
  grouped: boolean;
  ctx: FeedContext;
  /** This message's answer is in flight. */
  answering: boolean;
  /** Answers go through the same injection as the composer; lock them together. */
  answersDisabled?: boolean;
  onAnswer: (messageId: string, option: ChatQuestionOption) => void;
}): JSX.Element {
  if (message.authorKind === "user") {
    return (
      <Post
        author={userAuthor()}
        at={message.createdAt}
        grouped={grouped}
        data-testid="chat-message"
        data-author="user"
        data-message-id={message.id}
      >
        {message.text ? (
          <div className="whitespace-pre-wrap break-words">{message.text}</div>
        ) : null}
        <AttachmentList
          attachments={message.attachments}
          at={message.createdAt}
          ctx={ctx}
        />
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
        data-testid="chat-message"
        data-author="agent"
        data-kind="update"
        data-message-id={message.id}
      >
        <Markdown className="text-muted-foreground prose-p:my-0.5">
          {message.text}
        </Markdown>
        <AttachmentList
          attachments={message.attachments}
          at={message.createdAt}
          ctx={ctx}
        />
      </Post>
    );
  }

  const body = (
    <>
      <Markdown>{message.text}</Markdown>
      <AttachmentList
        attachments={message.attachments}
        at={message.createdAt}
        ctx={ctx}
      />
    </>
  );

  return (
    <Post
      author={author}
      at={message.createdAt}
      grouped={grouped}
      data-testid="chat-message"
      data-author="agent"
      data-kind={message.kind}
      data-message-id={message.id}
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

/** A muted system line, aligned with the post bodies like "joined the channel". */
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
      className="flex items-center gap-3 px-4 py-0.5 text-[11px] text-muted-foreground"
      data-testid="chat-status"
      title={formatDateTime(entry.at)}
    >
      <div className="flex w-8 shrink-0 justify-center">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full bg-current",
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

export function agentMessageAuthor(
  entry: ChatAgentMessageEntry,
  ctx: FeedContext
): PostAuthor {
  return entry.direction === "out"
    ? agentAuthor(ctx, entry.senderName)
    : peerAuthor(entry.senderAgentId, entry.senderName);
}

export function AgentMessageView({
  entry,
  grouped,
  ctx,
}: {
  entry: ChatAgentMessageEntry;
  grouped: boolean;
  ctx: FeedContext;
}): JSX.Element {
  const isSent = entry.direction === "out";
  const { delivered } = entry;
  return (
    <Post
      author={agentMessageAuthor(entry, ctx)}
      at={entry.at}
      grouped={grouped}
      data-testid="chat-agent-message"
      data-direction={entry.direction}
    >
      {isSent ? (
        <div className="text-[11px] text-muted-foreground">
          to {entry.recipientName}
        </div>
      ) : null}
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
  ctx,
}: {
  entry: ChatMediaEntry;
  grouped: boolean;
  ctx: FeedContext;
}): JSX.Element {
  const url = mediaFileUrl(ctx.agentId, entry.fileName);
  const open = () =>
    ctx.onOpenMedia({
      ownerAgentId: ctx.agentId,
      name: entry.fileName,
      size: entry.sizeBytes,
      updatedAt: entry.at,
      url,
      description: entry.description,
    });
  const isImage = isImageFile(entry.fileName);
  return (
    <Post
      author={agentAuthor(ctx, "Agent")}
      at={entry.at}
      grouped={grouped}
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
            <img
              src={url}
              alt={entry.description ?? entry.fileName}
              className="mt-1.5 block max-h-64 max-w-xs rounded-md border border-border object-contain transition-colors hover:border-foreground/30"
              loading="lazy"
            />
          ) : null}
        </button>
      </AttachmentBlock>
    </Post>
  );
}
