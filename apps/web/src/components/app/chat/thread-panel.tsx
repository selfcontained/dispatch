/**
 * The thread behind one block, Slack-style: a panel to the right of the
 * stream (a full-width sheet on a phone) showing the root block, its
 * replies, and a composer whose posts reply under the root. Replies never
 * render in the main stream; this is the only place they appear.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Block, BlockOption, ChatTurnEntry } from "@dispatch/shared";
import { ArrowLeft, X } from "lucide-react";

import { FindingDetail, findingIdOf } from "@/components/app/chat/block-bodies";

import { type ChatUserAttachmentInput } from "@/components/app/chat/chat-attachments";
import { ChatComposer } from "@/components/app/chat/chat-composer";
import {
  BlockView,
  agentDisplayName,
  blockAuthor,
  type FeedContext,
} from "@/components/app/chat/chat-entries";
import { TurnEntryView } from "@/components/app/chat/turn/turn-entry-view";
import { Button } from "@/components/ui/button";
import {
  useMarkThreadRead,
  usePostBlock,
  useStreamFeedCache,
  useThread,
} from "@/hooks/use-stream";
import { uploadAgentFile } from "@/lib/file-upload";
import { cn } from "@/lib/utils";

/** Posts by one author this close together share a header, as in the feed. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** What the thread is about, in a few words: the root's text, or its kind. */
/** Markdown's marks, off a line that is shown as plain text. */
function plainLine(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|$)/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function threadSubject(root: Block): string {
  const text = plainLine(root.text);
  if (text) return text.length > 70 ? `${text.slice(0, 69).trimEnd()}…` : text;
  if (root.kind === "review" && root.data && "summary" in root.data) {
    const summary = plainLine(String(root.data.summary ?? ""));
    return summary.length > 70 ? `${summary.slice(0, 69).trimEnd()}…` : summary;
  }
  return (
    {
      text: "",
      question: "a question",
      form: "a form",
      file: "a file",
      link: "a link",
      review: "a review",
      tasks: "a task list",
    }[root.kind] ?? ""
  );
}

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

/** What the drawer's header says over a thread page: a title and a line under it. */
export function threadTitle(
  root: Block | null,
  finding: boolean,
  nameOf: (agentId: string) => string
): { title: string; subtitle: string } {
  if (!root) return { title: finding ? "Finding" : "Thread", subtitle: "" };
  const by = root.author.kind === "agent" ? nameOf(root.author.agentId) : "you";
  if (finding) return { title: "Finding", subtitle: `in the review by ${by}` };
  if (root.kind === "review") return { title: "Review", subtitle: `by ${by}` };
  const subject = threadSubject(root);
  return { title: "Thread", subtitle: subject ? `${by}: ${subject}` : by };
}

/** What the panel lists under the root: a reply, or the turn a reply opened. */
type ThreadItem =
  | { kind: "reply"; at: string; reply: Block }
  | { kind: "turn"; at: string; turn: ChatTurnEntry };

export type ThreadPanelProps = {
  /** The page's agent: owns the files a reply attaches. */
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
  /**
   * Render the panel's own header (title, back/close). Off inside the
   * drawer, whose chrome carries the title and the way back.
   */
  chrome?: boolean;
  /** A failed action to show above the composer. */
  error?: string | null;
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
  chrome = true,
  error = null,
}: ThreadPanelProps): JSX.Element {
  const thread = useThread(rootId, blockId);
  const post = usePostBlock(rootId);
  const { mutateAsync: postAsync } = post;

  // On a review, a finding id turns the panel into that finding's own:
  // the finding in full, its status controls, and only its discussion.
  const finding =
    findingId && thread.root?.kind === "review"
      ? (thread.root.data.findings.find((f) => f.id === findingId) ?? null)
      : null;
  // A reply that opened a turn of the page's agent is drawn by that turn,
  // here as in the stream: the turns the feed holds for this thread take
  // the place of the replies that started them, in time order. Another
  // agent's turns stay out; what it said is already here as its replies.
  const entries = useStreamFeedCache(rootId);
  const turns = useMemo(
    () =>
      entries.filter(
        (entry): entry is ChatTurnEntry =>
          entry.type === "turn" &&
          entry.agentId === agentId &&
          entry.prompt.threadId === blockId
      ),
    [agentId, blockId, entries]
  );
  const replies = useMemo(
    () =>
      finding
        ? thread.replies.filter((reply) => findingIdOf(reply) === finding.id)
        : thread.replies,
    [finding, thread.replies]
  );
  const items = useMemo<ThreadItem[]>(() => {
    const shown = new Set(replies.map((reply) => reply.id));
    const opened = new Map<string, ChatTurnEntry>();
    for (const turn of turns) {
      const promptId = turn.prompt.chatMessageId;
      // In a finding's panel only the turns its own comments opened.
      if (!promptId || (finding && !shown.has(promptId))) continue;
      opened.set(promptId, turn);
    }
    const list: ThreadItem[] = replies
      .filter((reply) => !opened.has(reply.id))
      .map((reply) => ({ kind: "reply", at: reply.createdAt, reply }));
    for (const turn of opened.values()) {
      list.push({ kind: "turn", at: turn.at, turn });
    }
    return list.sort((a, b) => a.at.localeCompare(b.at));
  }, [finding, replies, turns]);
  const grouped = useMemo(() => groupReplies(replies, ctx), [ctx, replies]);
  const groupedById = useMemo(
    () => new Map(replies.map((reply, index) => [reply.id, grouped[index]])),
    [grouped, replies]
  );

  // Seeing the discussion is reading it: agent comments in view lose their
  // unread mark, on the finding's own panel only that finding's.
  const markRead = useMarkThreadRead(rootId);
  const { mutate: markReadNow, isPending: marking } = markRead;
  const unseen = replies.some(
    (reply) => reply.author.kind === "agent" && reply.readAt === null
  );
  const findingKey = finding?.id ?? null;
  useEffect(() => {
    if (!unseen || marking) return;
    markReadNow({ blockId, finding: findingKey });
  }, [unseen, marking, blockId, findingKey, markReadNow]);

  const onSend = useCallback(
    async (
      text: string,
      attachments: ChatUserAttachmentInput[]
    ): Promise<void> => {
      await postAsync({
        text,
        attachments,
        replyTo: blockId,
        ...(finding ? { finding: finding.id } : {}),
      });
    },
    [blockId, finding, postAsync]
  );

  const uploadFile = useCallback(
    (file: File) =>
      uploadAgentFile(agentId, file, { source: "user", inject: false }),
    [agentId]
  );

  // The page opens at its top: the review, the finding, the post the
  // thread is under. A reply that lands while it is open scrolls into
  // view at the bottom.
  const scrollRef = useRef<HTMLDivElement>(null);
  const replyCount = thread.replies.length;
  const seenRepliesRef = useRef<{ blockId: string; count: number } | null>(
    null
  );
  useEffect(() => {
    const el = scrollRef.current;
    const seen = seenRepliesRef.current;
    if (!seen || seen.blockId !== blockId) {
      seenRepliesRef.current = { blockId, count: replyCount };
      if (el) el.scrollTop = 0;
      return;
    }
    if (replyCount > seen.count && el) el.scrollTop = el.scrollHeight;
    seen.count = replyCount;
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
        "flex min-h-0 flex-1 flex-col",
        chrome && "bg-background",
        chrome &&
          (isMobile
            ? "absolute inset-0 z-20"
            : "w-[26rem] shrink-0 border-l border-border/40")
      )}
      role="complementary"
      aria-label={finding ? "Finding" : "Thread"}
      data-testid="chat-thread-panel"
      data-block-id={blockId}
      data-finding-id={finding?.id ?? undefined}
      data-mobile={isMobile ? "true" : undefined}
    >
      {chrome ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-muted/30 px-3 py-2">
          {isMobile ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label="Back to the channel"
              data-testid="chat-thread-close"
              onClick={onClose}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground">
              {finding ? "Finding" : "Thread"}
            </div>
            {finding ? (
              <button
                type="button"
                className="block max-w-full truncate text-[11.5px] text-muted-foreground underline-offset-2 hover:underline"
                data-testid="chat-thread-subject"
                onClick={() => ctx.onOpenThread?.(blockId)}
                title="Back to the review"
              >
                ← in the review by{" "}
                {thread.root ? blockAuthor(thread.root, ctx).name : ""}
              </button>
            ) : thread.root ? (
              <div
                className="truncate text-[11.5px] text-muted-foreground"
                data-testid="chat-thread-subject"
              >
                on {blockAuthor(thread.root, ctx).name}
                {threadSubject(thread.root)
                  ? `: ${threadSubject(thread.root)}`
                  : ""}
              </div>
            ) : null}
          </div>
          {isMobile ? null : (
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
          )}
        </div>
      ) : null}
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
        {thread.root && finding && thread.root.kind === "review" ? (
          <div className="px-3 pb-2 pt-1">
            <FindingDetail
              block={thread.root}
              finding={finding}
              disabled={disabledReason !== null || !ctx.onSetBlockState}
              onSetState={
                ctx.onSetBlockState
                  ? (patch) => ctx.onSetBlockState?.(blockId, patch)
                  : undefined
              }
              onOpenPath={ctx.onOpenPath}
              authorName={(by) =>
                by.kind === "user" ? "you" : agentDisplayName(by.agentId, ctx)
              }
            />
          </div>
        ) : thread.root ? (
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
        ) : null}
        {thread.root ? (
          <>
            {replies.length > 0 ? (
              <div
                className="mx-4 mt-2 border-t border-border/40 pt-1 text-[11px] text-muted-foreground"
                data-testid="chat-thread-count"
              >
                {replies.length}{" "}
                {replies.length === 1
                  ? finding
                    ? "comment"
                    : "reply"
                  : finding
                    ? "comments"
                    : "replies"}
              </div>
            ) : null}
            <div data-testid="chat-thread-replies">
              {items.map((item) =>
                item.kind === "turn" ? (
                  <div
                    key={item.turn.id}
                    data-testid="chat-thread-turn"
                    data-turn-id={item.turn.id}
                  >
                    <TurnEntryView
                      entry={item.turn}
                      grouped={false}
                      ctx={ctx}
                    />
                  </div>
                ) : (
                  <BlockView
                    key={item.reply.id}
                    block={item.reply}
                    held={false}
                    grouped={groupedById.get(item.reply.id) ?? false}
                    ctx={ctx}
                    answering={answeringBlockId === item.reply.id}
                    submitting={submittingBlockId === item.reply.id}
                    answersDisabled={disabledReason !== null}
                    onAnswer={onAnswer}
                    inThread
                  />
                )
              )}
            </div>
          </>
        ) : null}
      </div>
      <div className="shrink-0 border-t border-border/40 px-4 pb-3 pt-2">
        {error ? (
          <div
            role="alert"
            className="mb-1.5 truncate text-[11px] text-destructive"
            data-testid="chat-thread-action-error"
          >
            {error}
          </div>
        ) : null}
        <ChatComposer
          // No persisted draft: a thread's half-typed reply is not worth
          // keeping across reloads, and sharing the agent's key would
          // swap drafts with the main composer.
          agentId={null}
          onSend={onSend}
          uploadFile={uploadFile}
          disabledReason={disabledReason}
          sending={post.isPending}
          placeholder={
            finding ? "Comment on this finding…" : "Reply in thread…"
          }
          autoFocus={!isMobile}
        />
      </div>
    </aside>
  );
}
