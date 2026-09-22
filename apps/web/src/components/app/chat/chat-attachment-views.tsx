/**
 * The attachments a post hangs under itself: files, links, PRs and code.
 * Presentational leaves — each takes an attachment and renders it;
 * none of them reads the feed beyond the three fields `AttachmentCtx`
 * names. Split out of chat-entries.tsx, which composes them into posts.
 */
import { type ReactNode } from "react";
import type { Block, ChatAttachment } from "@dispatch/shared";
import {
  ArrowUpRight,
  ExternalLink,
  FileText,
  GitPullRequest,
} from "lucide-react";

import type { FeedContext } from "@/components/app/chat/chat-entries";
import { FeedImage } from "@/components/app/chat/feed-image";
import { formatBytes } from "@/components/app/service-resources-format";
import { Markdown } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";

import { isImageFile } from "../../../../../server/src/shared/file-types";

/** What the attachment views read off the feed they are rendered in. */
type AttachmentCtx = Pick<FeedContext, "agentId" | "agentName" | "onOpenFile">;

/** The URL a file is served from. */
export function fileUrl(agentId: string, fileName: string): string {
  return `/api/v1/agents/${agentId}/files/${encodeURIComponent(fileName)}`;
}

/**
 * The agent whose files directory holds a post's file. Attachments carry
 * it; ones written before they did fall back to what the post implies —
 * an agent posts its own files, a person's post holds the files of the
 * agent it was sent to.
 */
export function fileOwnerOf(
  attachment: Extract<ChatAttachment, { type: "file" }>,
  block: Pick<Block, "author" | "toAgentId">,
  pageAgentId: string
): string {
  if (attachment.ownerAgentId) return attachment.ownerAgentId;
  if (block.author.kind === "agent") return block.author.agentId;
  return block.toAgentId ?? pageAgentId;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * A card under a post: what the post hands over, boxed so it reads as a
 * thing (a file, a pull request, a link) and not as more of the text.
 */
export function AttachmentBlock({
  children,
  className,
  accent,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  /** Extra border classes, for a card that wants a colour of its own. */
  accent?: string;
  [dataAttr: `data-${string}`]: string | undefined;
}): JSX.Element {
  return (
    <div
      className={cn(
        "w-fit max-w-full overflow-hidden rounded-md border border-border/70 bg-muted/25",
        accent,
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** The squared tile at the left of a card: an icon, or a file's extension. */
function Tile({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background text-foreground/80">
      {children}
    </span>
  );
}

const CARD_ROW =
  "flex min-w-[14rem] max-w-md items-center gap-3 p-2 pr-3 text-left transition-colors hover:bg-muted/50";

export function LinkAttachment({
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
        className={cn("group/link", CARD_ROW)}
        title={href}
      >
        <Tile>{icon}</Tile>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {title ?? href}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {title && host ? host : "Opens in a new tab"}
          </span>
        </span>
        <ArrowUpRight
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover/link:text-foreground"
          aria-hidden="true"
        />
      </a>
    </AttachmentBlock>
  );
}

/** "md", "pdf": short enough to be the tile itself; longer ones get the icon. */
function extensionOf(fileName: string): string | null {
  const match = /\.([a-z0-9]{1,4})$/i.exec(fileName);
  return match ? match[1]!.toLowerCase() : null;
}

function FileAttachment({
  attachment,
  ownerAgentId,
  ctx,
}: {
  attachment: Extract<ChatAttachment, { type: "file" }>;
  ownerAgentId: string;
  ctx: AttachmentCtx;
}): JSX.Element {
  const url = fileUrl(ownerAgentId, attachment.fileName);
  const open = () => ctx.onOpenFile(attachment.fileId);
  // By stored name or by the file row's type: a file shared without an
  // extension still renders as the image it is.
  const isImage =
    isImageFile(attachment.fileName) ||
    (attachment.mimeType?.startsWith("image/") ?? false);
  if (isImage) {
    return (
      <AttachmentBlock data-testid="chat-attachment-image">
        <button
          type="button"
          onClick={open}
          className="block max-w-xs text-left"
          title={attachment.fileName}
        >
          <span className="block border-b border-border/70 bg-background/60">
            <FeedImage
              src={url}
              alt={attachment.fileName}
              width={attachment.width}
              height={attachment.height}
              maxHeightPx={224}
            />
          </span>
          <span className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <span className="min-w-0 truncate">{attachment.fileName}</span>
            <span className="ml-auto shrink-0">
              {formatBytes(attachment.sizeBytes)}
            </span>
          </span>
        </button>
      </AttachmentBlock>
    );
  }
  const extension = extensionOf(attachment.fileName);
  return (
    <AttachmentBlock data-testid="chat-attachment-file">
      <button
        type="button"
        onClick={open}
        className={CARD_ROW}
        title={attachment.fileName}
      >
        <Tile>
          {extension ? (
            <span className="font-mono text-[10px] font-semibold uppercase leading-none">
              {extension}
            </span>
          ) : (
            <FileText className="h-4 w-4" aria-hidden="true" />
          )}
        </Tile>
        <span className="min-w-0 flex-1">
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
    <AttachmentBlock className="w-full" data-testid="chat-attachment-code">
      {attachment.path ? (
        <div className="truncate border-b border-border/70 px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
          {attachment.path}
        </div>
      ) : null}
      <div className="p-1.5 [&_pre]:my-0">
        <Markdown className="text-xs">{source}</Markdown>
      </div>
    </AttachmentBlock>
  );
}

function AttachmentView({
  attachment,
  block,
  ctx,
}: {
  attachment: ChatAttachment;
  block: AttachmentBlockOf;
  ctx: AttachmentCtx;
}): JSX.Element {
  switch (attachment.type) {
    case "file":
      return (
        <FileAttachment
          attachment={attachment}
          ownerAgentId={fileOwnerOf(attachment, block, ctx.agentId)}
          ctx={ctx}
        />
      );
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
  }
}

/** What the list reads off the post its attachments hang under. */
type AttachmentBlockOf = Pick<Block, "author" | "toAgentId" | "attachments">;

export function AttachmentList({
  block,
  ctx,
}: {
  block: AttachmentBlockOf;
  ctx: AttachmentCtx;
}): JSX.Element | null {
  if (block.attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {block.attachments.map((attachment, index) => (
        <AttachmentView
          key={index}
          attachment={attachment}
          block={block}
          ctx={ctx}
        />
      ))}
    </div>
  );
}
