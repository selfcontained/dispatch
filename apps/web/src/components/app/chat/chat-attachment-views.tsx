/**
 * The blocks a chat post hangs under itself: files, links, PRs, code and
 * pins. Presentational leaves — each takes an attachment and renders it;
 * none of them reads the feed beyond the three fields `AttachmentCtx`
 * names. Split out of chat-entries.tsx, which composes them into posts.
 */
import { type ReactNode } from "react";
import type { ChatAttachment } from "@dispatch/shared";
import { ExternalLink, FileText, GitPullRequest } from "lucide-react";

import type { FeedContext } from "@/components/app/chat/chat-entries";
import { FeedImage } from "@/components/app/chat/feed-image";
import { usePinShortcuts } from "@/components/app/chat/pin-shortcut-context";
import { PinItem } from "@/components/app/pin-item";
import { formatBytes } from "@/components/app/service-resources-format";
import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";

import { isImageFile } from "../../../../../server/src/shared/media-file-types";

/** What the attachment views read off the feed they are rendered in. */
type AttachmentCtx = Pick<FeedContext, "agentId" | "agentName" | "onOpenMedia">;

/** The URL a media file is served from. */
export function mediaFileUrl(agentId: string, fileName: string): string {
  return `/api/v1/agents/${agentId}/media/${encodeURIComponent(fileName)}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** The left-accented block Slack hangs under a post. */
export function AttachmentBlock({
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
  ctx: AttachmentCtx;
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
          <FeedImage
            src={url}
            alt={attachment.fileName}
            width={attachment.width}
            height={attachment.height}
            maxHeightPx={224}
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
export function LivePin({
  pinId,
  label,
  ctx,
  testId,
}: {
  pinId: string;
  label?: string;
  ctx: AttachmentCtx;
  testId: string;
}): JSX.Element {
  const shortcuts = usePinShortcuts();
  const pin = shortcuts.pins.find((p) => p.id === pinId);
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
  // in the channel's wide measure would stretch into a banner, so here it
  // hugs its label up to a cap instead.
  return (
    <div
      className={
        pin.type === "shortcut"
          ? "w-fit max-w-[20rem]"
          : "max-w-md rounded-md border border-border bg-card/60 px-3 py-2"
      }
      data-testid={testId}
    >
      <PinItem
        pin={pin}
        workspaceRoot={shortcuts.workspaceRoot}
        inGroup
        agentIsRunning={shortcuts.agentIsRunning}
        onRunShortcut={shortcuts.onRunShortcut}
        pendingPinId={shortcuts.pendingPinId}
        agentName={ctx.agentName ?? null}
        buttonRef={shortcuts.registerShortcutButton}
      />
    </div>
  );
}

function PinAttachment({
  attachment,
  ctx,
}: {
  attachment: Extract<ChatAttachment, { type: "pin" }>;
  ctx: AttachmentCtx;
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
  ctx: AttachmentCtx;
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

export function AttachmentList({
  attachments,
  ctx,
}: {
  attachments: ChatAttachment[];
  ctx: AttachmentCtx;
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
