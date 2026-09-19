/**
 * The thread behind one block, Slack-style: a panel to the right of the
 * stream (a full-width sheet on a phone) showing the root block, its
 * replies, and a composer whose posts reply under the root. Replies never
 * render in the main stream; this is the only place they appear.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Block, BlockOption } from "@dispatch/shared";
import { X } from "lucide-react";

import { type ChatUserAttachmentInput } from "@/components/app/chat/chat-attachments";
import { ChatComposer } from "@/components/app/chat/chat-composer";
import {
  BlockView,
  blockAuthor,
  type FeedContext,
} from "@/components/app/chat/chat-entries";
import { Button } from "@/components/ui/button";
import { usePostBlock, useThread } from "@/hooks/use-stream";
import { uploadAgentMedia } from "@/lib/media-upload";
import { cn } from "@/lib/utils";

/** Posts by one author this close together share a header, as in the feed. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Whether each reply continues the one above it: same author within the
 * grouping window. The root always opens the panel with a full header.
 */
export function groupReplies(
  replies: readonly Block[],
  ctx: FeedContext
): boolean[] {
  let last: { key: string; at: number } | null = null;
  return replies.map((reply) => {
    const key = blockAuthor(reply, ctx).key;
    const at = Date.parse(reply.createdAt);
    const grouped =
      last !== null &&
      last.key === key &&
      Number.isFinite(at) &&
      at - last.at <= GROUP_WINDOW_MS;
    last = { key, at: Number.isFinite(at) ? at : 0 };
    return grouped;
  });
}

export type ThreadPanelProps = {
  /** The page's agent: owns the media a reply attaches. */
  agentId: string;
  /** The root of its lineage: the stream the thread lives in. */
  rootId: string;
  blockId: string;
  /** A finding to highlight on a review root, from `?finding=`. */
  findingId?: string | null;
  ctx: FeedContext;
  /** Why nothing can be posted right now, or null. */
  disabledReason: string | null;
  isMobile: boolean;
  onClose: () => void;
  onAnswer: (blockId: string, option: BlockOption) => void;
  answeringBlockId: string | null;
  submittingBlockId: string | null;
};

export function ThreadPanel({
  agentId,
  rootId,
  blockId,
  findingId = null,
  ctx,
  disabledReason,
  isMobile,
  onClose,
  onAnswer,
  answeringBlockId,
  submittingBlockId,
}: ThreadPanelProps): JSX.Element {
  const thread = useThread(rootId, blockId);
  const post = usePostBlock(rootId);
  const { mutateAsync: postAsync } = post;

  const grouped = useMemo(
    () => groupReplies(thread.replies, ctx),
    [ctx, thread.replies]
  );

  const onSend = useCallback(
    async (
      text: string,
      attachments: ChatUserAttachmentInput[]
    ): Promise<void> => {
      await postAsync({ text, attachments, replyTo: blockId });
    },
    [blockId, postAsync]
  );

  const uploadFile = useCallback(
    (file: File) =>
      uploadAgentMedia(agentId, file, { source: "user", inject: false }),
    [agentId]
  );

  // New replies land at the bottom; keep the newest in view.
  const scrollRef = useRef<HTMLDivElement>(null);
  const replyCount = thread.replies.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replyCount, blockId]);

  // Escape closes the panel, as it would a sheet.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col bg-background",
        isMobile
          ? "absolute inset-0 z-20"
          : "w-[26rem] shrink-0 border-l border-border/40"
      )}
      role="complementary"
      aria-label="Thread"
      data-testid="chat-thread-panel"
      data-block-id={blockId}
      data-mobile={isMobile ? "true" : undefined}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/40 px-4 py-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">Thread</div>
          {thread.root ? (
            <div className="truncate text-[11px] text-muted-foreground">
              {blockAuthor(thread.root, ctx).name}
            </div>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label="Close thread"
          data-testid="chat-thread-close"
          onClick={onClose}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2"
        data-testid="chat-thread-scroll"
      >
        {thread.error ? (
          <div
            role="alert"
            className="mx-4 mb-3 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            data-testid="chat-thread-error"
          >
            <span className="min-w-0 truncate">
              Couldn&apos;t load the thread: {thread.error.message}
            </span>
            <Button
              type="button"
              size="sm"
              variant="default"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={thread.refetch}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {thread.isLoading && !thread.root ? (
          <div
            className="px-4 py-6 text-center text-xs text-muted-foreground"
            data-testid="chat-thread-loading"
          >
            Loading the thread…
          </div>
        ) : null}
        {thread.root ? (
          <>
            <BlockView
              block={thread.root}
              held={false}
              grouped={false}
              ctx={ctx}
              answering={answeringBlockId === thread.root.id}
              submitting={submittingBlockId === thread.root.id}
              answersDisabled={disabledReason !== null}
              onAnswer={onAnswer}
              inThread
              highlightFindingId={findingId}
            />
            {thread.replies.length > 0 ? (
              <div
                className="mx-4 mt-2 border-t border-border/40 pt-1 text-[11px] text-muted-foreground"
                data-testid="chat-thread-count"
              >
                {thread.replies.length}{" "}
                {thread.replies.length === 1 ? "reply" : "replies"}
              </div>
            ) : null}
            <div data-testid="chat-thread-replies">
              {thread.replies.map((reply, index) => (
                <BlockView
                  key={reply.id}
                  block={reply}
                  held={false}
                  grouped={grouped[index] ?? false}
                  ctx={ctx}
                  answering={answeringBlockId === reply.id}
                  submitting={submittingBlockId === reply.id}
                  answersDisabled={disabledReason !== null}
                  onAnswer={onAnswer}
                  inThread
                />
              ))}
            </div>
          </>
        ) : null}
      </div>
      <div className="shrink-0 border-t border-border/40 px-4 pb-3 pt-2">
        <ChatComposer
          // No persisted draft: a thread's half-typed reply is not worth
          // keeping across reloads, and sharing the agent's key would
          // swap drafts with the main composer.
          agentId={null}
          onSend={onSend}
          uploadFile={uploadFile}
          disabledReason={disabledReason}
          sending={post.isPending}
          placeholder="Reply in thread…"
          autoFocus={!isMobile}
        />
      </div>
    </aside>
  );
}
