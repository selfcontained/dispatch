/**
 * The attachments a post hangs under itself: files, links, PRs and code.
 * Presentational leaves — each takes an attachment and renders it;
 * none of them reads the feed beyond the three fields `AttachmentCtx`
 * names. Split out of chat-entries.tsx, which composes them into posts.
 */
import { type ReactNode } from "react";
import {
  CHAT_GALLERY_MAX_TILES,
  layoutAttachments,
  type Block,
  type ChatAttachment,
  type ChatFileAttachment,
} from "@dispatch/shared";
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
  attachment: ChatFileAttachment;
  ownerAgentId: string;
  ctx: AttachmentCtx;
}): JSX.Element {
  const url = fileUrl(ownerAgentId, attachment.fileName);
  const open = () => ctx.onOpenFile(attachment.fileId);
  if (attachment.media === "image") {
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

/**
 * A post's images, laid out by `layoutAttachments`, as square tiles cropped to fill: a 2-column grid that
 * spans a phone's width, a wrapping row of fixed tiles on anything wider.
 * Every tile's size is set by the layout alone, so the gallery reserves its
 * full height before a single image loads. The file's name and size move to
 * the tile's tooltip and label; the lightbox shows the whole picture.
 */
function ImageGallery({
  images,
  block,
  ctx,
}: {
  images: ChatFileAttachment[];
  block: AttachmentBlockOf;
  ctx: AttachmentCtx;
}): JSX.Element {
  const overflow =
    images.length > CHAT_GALLERY_MAX_TILES
      ? images.length - (CHAT_GALLERY_MAX_TILES - 1)
      : 0;
  const shown = overflow ? images.slice(0, CHAT_GALLERY_MAX_TILES) : images;
  // Prev/next in the lightbox walk this post's images, so "+N" leads on to
  // the ones it stands for.
  const order = images.map((image) => image.fileId);
  return (
    <div
      className="grid w-full max-w-md grid-cols-2 gap-1.5 sm:flex sm:max-w-none sm:flex-wrap"
      data-testid="chat-attachment-gallery"
    >
      {shown.map((attachment, index) => {
        const more = overflow > 0 && index === shown.length - 1 ? overflow : 0;
        const label = `${attachment.fileName} (${formatBytes(attachment.sizeBytes)})`;
        return (
          <button
            key={`${attachment.fileId}-${index}`}
            type="button"
            onClick={() => ctx.onOpenFile(attachment.fileId, order)}
            className="relative aspect-square overflow-hidden rounded-md border border-border/70 bg-muted/30 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-40"
            title={label}
            aria-label={more ? `${label}, and ${more - 1} more` : label}
            data-testid="chat-attachment-gallery-tile"
          >
            <img
              src={fileUrl(
                fileOwnerOf(attachment, block, ctx.agentId),
                attachment.fileName
              )}
              alt={attachment.fileName}
              className="h-full w-full object-cover"
              loading="lazy"
            />
            {more ? (
              <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-xl font-semibold text-white">
                +{more}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
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
      {layoutAttachments(block.attachments).map((group, index) =>
        group.kind === "gallery" ? (
          <ImageGallery
            key={index}
            images={group.images}
            block={block}
            ctx={ctx}
          />
        ) : (
          <AttachmentView
            key={index}
            attachment={group.attachment}
            block={block}
            ctx={ctx}
          />
        )
      )}
    </div>
  );
}
