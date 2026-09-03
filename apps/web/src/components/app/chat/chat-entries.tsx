import { memo } from "react";
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
  Paperclip,
} from "lucide-react";

import {
  latestEventColor,
  latestEventLabel,
} from "@/components/app/agent-event-utils";
import { MessageBubble } from "@/components/app/messages-panel";
import { PinItem } from "@/components/app/pin-item";
import { type AgentPin, type MediaFile } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { formatBytes } from "@/components/app/service-resources-format";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

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

export function isImageFileName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name);
}

export function mediaFileUrl(agentId: string, fileName: string): string {
  return `/api/v1/agents/${agentId}/media/${encodeURIComponent(fileName)}`;
}

export function fullTimestamp(iso: string): string {
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? iso : time.toLocaleString();
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export type AttachmentContext = {
  agentId: string;
  pins: AgentPin[];
  workspaceRoot: string | null;
  onOpenMedia: (file: MediaFile) => void;
};

function LinkChip({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: JSX.Element;
}): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted"
      title={href}
    >
      {icon}
      <span className="truncate">{label}</span>
    </a>
  );
}

function FileAttachment({
  attachment,
  at,
  ctx,
}: {
  attachment: Extract<ChatAttachment, { type: "file" }>;
  at: string;
  ctx: AttachmentContext;
}): JSX.Element {
  const url = mediaFileUrl(ctx.agentId, attachment.fileName);
  const open = () =>
    ctx.onOpenMedia({
      name: attachment.fileName,
      size: attachment.sizeBytes,
      updatedAt: at,
      url,
    });
  if (isImageFileName(attachment.fileName)) {
    return (
      <button
        type="button"
        onClick={open}
        className="block max-w-xs overflow-hidden rounded-md border border-border bg-background/60 text-left transition-colors hover:border-foreground/30"
        title={attachment.fileName}
        data-testid="chat-attachment-image"
      >
        <img
          src={url}
          alt={attachment.fileName}
          className="max-h-56 w-full object-contain"
          loading="lazy"
        />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={open}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted"
      title={attachment.path}
      data-testid="chat-attachment-file"
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{attachment.fileName}</span>
      <span className="shrink-0 text-muted-foreground">
        {formatBytes(attachment.sizeBytes)}
      </span>
    </button>
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
    <div className="max-w-full" data-testid="chat-attachment-code">
      <Markdown className="text-xs">{source}</Markdown>
      {attachment.path ? (
        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
          {attachment.path}
        </div>
      ) : null}
    </div>
  );
}

function PinAttachment({
  attachment,
  ctx,
}: {
  attachment: Extract<ChatAttachment, { type: "pin" }>;
  ctx: AttachmentContext;
}): JSX.Element {
  const pin = ctx.pins.find((p) => p.id === attachment.pinId);
  if (!pin) {
    return (
      <div
        className="text-xs italic text-muted-foreground"
        data-testid="chat-attachment-pin-missing"
      >
        Pin no longer available
      </div>
    );
  }
  return (
    <div
      className="rounded-md border border-border bg-background/60 px-3 py-1"
      data-testid="chat-attachment-pin"
    >
      <PinItem pin={pin} workspaceRoot={ctx.workspaceRoot} inGroup />
    </div>
  );
}

export function AttachmentView({
  attachment,
  at,
  ctx,
}: {
  attachment: ChatAttachment;
  at: string;
  ctx: AttachmentContext;
}): JSX.Element {
  switch (attachment.type) {
    case "file":
      return <FileAttachment attachment={attachment} at={at} ctx={ctx} />;
    case "link":
      return (
        <LinkChip
          href={attachment.url}
          label={attachment.title ?? attachment.url}
          icon={<ExternalLink className="h-3.5 w-3.5 shrink-0" />}
        />
      );
    case "pr":
      return (
        <LinkChip
          href={attachment.url}
          label={attachment.title ?? attachment.url}
          icon={<GitPullRequest className="h-3.5 w-3.5 shrink-0" />}
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
  ctx: AttachmentContext;
}): JSX.Element | null {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" data-testid="chat-attachments">
      {attachments.map((attachment, index) => (
        <AttachmentView key={index} attachment={attachment} at={at} ctx={ctx} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export function QuestionOptions({
  message,
  answering,
  onAnswer,
}: {
  message: ChatMessage;
  answering: boolean;
  onAnswer: (option: ChatQuestionOption) => void;
}): JSX.Element | null {
  const question = message.question;
  if (!question) return null;
  const answer = message.answer;
  return (
    <div className="mt-2" data-testid="chat-question-options">
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
              className={cn("h-7 gap-1 text-xs", chosen && "cursor-default")}
              disabled={answer !== null || answering}
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
      {answer === null && question.allowFreeform ? (
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          Or type a reply below.
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

function MessageMeta({
  message,
  held,
  className,
}: {
  message: ChatMessage;
  held: boolean;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn("mt-1 flex items-center gap-1.5 text-[10px]", className)}
    >
      <span title={fullTimestamp(message.createdAt)}>
        {formatRelativeTime(message.createdAt)}
      </span>
      {message.authorKind === "user" && message.delivered === false ? (
        <span
          className="inline-flex items-center gap-1 text-destructive"
          title="The agent had no terminal to receive this message."
          data-testid="chat-delivery-failed"
        >
          <AlertTriangle className="h-2.5 w-2.5" />
          not delivered
        </span>
      ) : null}
      {held ? (
        <span
          className="inline-flex items-center gap-1"
          title="Dispatch is holding this message until you pause typing in the Console."
          data-testid="chat-held-hint"
        >
          <Hourglass className="h-2.5 w-2.5" />
          waiting to deliver
        </span>
      ) : null}
    </div>
  );
}

export const ChatMessageView = memo(function ChatMessageView({
  message,
  held,
  ctx,
  answering,
  onAnswer,
}: {
  message: ChatMessage;
  held: boolean;
  ctx: AttachmentContext;
  answering: boolean;
  onAnswer: (messageId: string, option: ChatQuestionOption) => void;
}): JSX.Element {
  if (message.authorKind === "user") {
    return (
      <div
        className="flex justify-end"
        data-testid="chat-message"
        data-author="user"
        data-message-id={message.id}
      >
        <div className="max-w-[85%] rounded-xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
          <div className="whitespace-pre-wrap break-words">{message.text}</div>
          <MessageMeta
            message={message}
            held={held}
            className="text-primary-foreground/60"
          />
        </div>
      </div>
    );
  }

  const isQuestion = message.kind === "question";
  const unanswered = isQuestion && message.answer === null;

  if (message.kind === "update") {
    return (
      <div
        className="flex justify-start"
        data-testid="chat-message"
        data-author="agent"
        data-kind="update"
        data-message-id={message.id}
      >
        <div className="max-w-[85%] px-1 text-sm text-muted-foreground">
          <Markdown className="text-muted-foreground prose-p:my-0.5">
            {message.text}
          </Markdown>
          <AttachmentList
            attachments={message.attachments}
            at={message.createdAt}
            ctx={ctx}
          />
          <MessageMeta message={message} held={false} />
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex justify-start"
      data-testid="chat-message"
      data-author="agent"
      data-kind={message.kind}
      data-message-id={message.id}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-xl rounded-bl-sm px-3 py-2 text-sm",
          message.kind === "summary"
            ? "border border-border bg-card"
            : "bg-muted",
          unanswered && "ring-1 ring-status-waiting"
        )}
      >
        {message.kind === "summary" ? (
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Summary
          </div>
        ) : null}
        {unanswered ? (
          <div
            className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-status-waiting"
            data-testid="chat-needs-reply"
          >
            Needs your reply
          </div>
        ) : null}
        <Markdown>{message.text}</Markdown>
        <AttachmentList
          attachments={message.attachments}
          at={message.createdAt}
          ctx={ctx}
        />
        {isQuestion ? (
          <QuestionOptions
            message={message}
            answering={answering}
            onAnswer={(option) => onAnswer(message.id, option)}
          />
        ) : null}
        <MessageMeta
          message={message}
          held={false}
          className="text-muted-foreground"
        />
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Status, cross-agent messages, media
// ---------------------------------------------------------------------------

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
      className="flex items-center justify-center gap-1.5 px-4 text-[11px] text-muted-foreground"
      data-testid="chat-status"
      data-event-type={entry.eventType}
      title={fullTimestamp(entry.at)}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full bg-current",
          latestEventColor(type)
        )}
      />
      <span className="truncate">
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

export function AgentMessageView({
  entry,
}: {
  entry: ChatAgentMessageEntry;
}): JSX.Element {
  const isSent = entry.direction === "out";
  return (
    <div data-testid="chat-agent-message" data-direction={entry.direction}>
      <div
        className={cn(
          "mb-0.5 text-[10px] text-muted-foreground",
          isSent ? "text-right" : "text-left"
        )}
      >
        {isSent ? `To ${entry.recipientName}` : `From ${entry.senderName}`}
      </div>
      <MessageBubble
        message={{
          id: entry.id,
          senderAgentId: entry.senderAgentId,
          recipientAgentId: entry.recipientAgentId,
          senderName: entry.senderName,
          recipientName: entry.recipientName,
          content: entry.content,
          delivered: entry.delivered,
          // The chat feed has its own read model; never show the sidebar's
          // unread ring here.
          readAt: entry.at,
          createdAt: entry.at,
        }}
        isSent={isSent}
      />
    </div>
  );
}

export function MediaEntryView({
  entry,
  ctx,
}: {
  entry: ChatMediaEntry;
  ctx: AttachmentContext;
}): JSX.Element {
  const url = mediaFileUrl(ctx.agentId, entry.fileName);
  const open = () =>
    ctx.onOpenMedia({
      name: entry.fileName,
      size: entry.sizeBytes,
      updatedAt: entry.at,
      url,
      description: entry.description,
    });
  const isImage = isImageFileName(entry.fileName);
  return (
    <div className="flex justify-start" data-testid="chat-media">
      <button
        type="button"
        onClick={open}
        className="max-w-[85%] overflow-hidden rounded-xl rounded-bl-sm border border-border bg-card text-left transition-colors hover:border-foreground/30"
        title={entry.fileName}
      >
        {isImage ? (
          <img
            src={url}
            alt={entry.description ?? entry.fileName}
            className="max-h-64 w-full object-contain"
            loading="lazy"
          />
        ) : null}
        <div className="flex items-center gap-2 px-3 py-2">
          <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate text-xs text-foreground">
              {entry.description ?? entry.fileName}
            </div>
            <div className="truncate text-[10px] text-muted-foreground">
              {entry.fileName} · {formatBytes(entry.sizeBytes)} ·{" "}
              <span title={fullTimestamp(entry.at)}>
                {formatRelativeTime(entry.at)}
              </span>
            </div>
          </div>
        </div>
      </button>
    </div>
  );
}
