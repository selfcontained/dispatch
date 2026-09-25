/**
 * The thread behind one block, Slack-style: a panel to the right of the
 * stream (a full-width sheet on a phone) showing the root block, its
 * replies, and a composer whose posts reply under the root. Replies never
 * render in the main stream; this is the only place they appear.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { Block, BlockOption } from "@dispatch/shared";
import { ArrowLeft, X } from "lucide-react";

import {
  FindingChangeEntry,
  findingChange,
} from "@/components/app/chat/block-bodies";

import { type ChatUserAttachmentInput } from "@/components/app/chat/chat-attachments";
import { PermissionRequests } from "./permission-requests";
import { ChatComposer } from "@/components/app/chat/chat-composer";
import {
  BlockView,
  agentDisplayName,
  blockAuthor,
  type FeedContext,
  mentionablesOf,
} from "@/components/app/chat/chat-entries";
import { Button } from "@/components/ui/button";
import { useBlockJump } from "@/hooks/use-block-jump";
import { useMarkThreadRead, usePostBlock, useThread } from "@/hooks/use-stream";
import { BLOCK_PARAM } from "@/lib/agent-routes";
import { uploadAgentFile } from "@/lib/file-upload";
import { cn } from "@/lib/utils";

import { ChatRowStateContext, type ChatRowState } from "./chat-row-state";
import { useFullHistory, useWindowedRows, WindowGap } from "./windowed-rows";

/** How long a jump outranks the panel's own open-at-the-top and follow. */
const JUMP_HOLD_MS = 1000;
/** The row a finding's latest change renders in, among its comments. */
const CHANGE_ROW_KEY = "finding-change";

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
  if (root.kind === "finding") return root.data.title;
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
      finding: "a finding",
      tasks: "a task list",
      launch: "",
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
  if (root.kind === "finding") {
    return { title: "Finding", subtitle: `in the review by ${by}` };
  }
  if (root.kind === "review") return { title: "Review", subtitle: `by ${by}` };
  if (root.kind === "launch") {
    const launcher = root.launchedByAgentId
      ? nameOf(root.launchedByAgentId)
      : "you";
    return {
      title: root.toAgentId ? nameOf(root.toAgentId) : "Thread",
      subtitle: `launched by ${launcher}`,
    };
  }
  const subject = threadSubject(root);
  return { title: "Thread", subtitle: subject ? `${by}: ${subject}` : by };
}

export type ThreadPanelProps = {
  /** The page's agent: owns the files a reply attaches. */
  agentId: string;
  /** The root of its lineage: the stream the thread lives in. */
  rootId: string;
  blockId: string;
  /**
   * A block shown in this thread whose own thread is open over it (a
   * finding on its review), from `?finding=`: the panel is that thread.
   */
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

/**
 * The feed's context, plus the names the thread carries for agents neither
 * the directory nor the feed has (an archived agent that only replied here).
 */
export function withThreadNames(
  ctx: FeedContext,
  names: Readonly<Record<string, string>> | undefined
): FeedContext {
  if (!names) return ctx;
  const missing = Object.entries(names).filter(
    ([id, name]) => ctx.names?.[id] !== name && !ctx.peers?.[id]
  );
  if (missing.length === 0) return ctx;
  return { ...ctx, names: { ...ctx.names, ...Object.fromEntries(missing) } };
}

export function ThreadPanel({
  agentId,
  rootId,
  blockId,
  findingId = null,
  ctx: feedCtx,
  disabledReason,
  isMobile,
  onClose,
  onAnswer,
  answeringBlockId,
  submittingBlockId,
  chrome = true,
  error = null,
}: ThreadPanelProps): JSX.Element {
  // With a finding open over it, the panel is the finding's own thread:
  // the finding in full, its status controls, and its discussion.
  const threadBlockId = findingId ?? blockId;
  const thread = useThread(rootId, threadBlockId);
  const ctx = useMemo(
    () => withThreadNames(feedCtx, thread.agentNames),
    [feedCtx, thread.agentNames]
  );
  const post = usePostBlock(rootId);
  const { mutateAsync: postAsync } = post;
  const finding = thread.root?.kind === "finding";
  const replies = thread.replies;
  const grouped = useMemo(() => groupReplies(replies, ctx), [ctx, replies]);
  // A finding's latest change is part of its discussion: who settled or
  // reopened it, and when, among the comments at the time it happened.
  const change = thread.root ? findingChange(thread.root) : null;
  const changeAt = change
    ? replies.filter((reply) => reply.createdAt <= change.at).length
    : -1;
  const changeEntry = change ? (
    <FindingChangeEntry
      record={change.record}
      authorName={(by) =>
        by.kind === "user" ? "you" : agentDisplayName(by.agentId, ctx)
      }
    />
  ) : null;
  const mentionables = useMemo(() => mentionablesOf(ctx), [ctx]);
  const groupedById = useMemo(
    () => new Map(replies.map((reply, index) => [reply.id, grouped[index]])),
    [grouped, replies]
  );

  // Seeing the discussion is reading it: agent comments in view lose their
  // unread mark.
  const markRead = useMarkThreadRead(rootId);
  const { mutate: markReadNow, isPending: marking } = markRead;
  const unseen = replies.some(
    (reply) => reply.author.kind === "agent" && reply.readAt === null
  );
  useEffect(() => {
    if (!unseen || marking) return;
    markReadNow({ blockId: threadBlockId });
  }, [unseen, marking, threadBlockId, markReadNow]);

  const onSend = useCallback(
    async (
      text: string,
      attachments: ChatUserAttachmentInput[],
      options?: { delivery?: "auto" | "queue" }
    ): Promise<void> => {
      await postAsync({
        text,
        attachments,
        replyTo: threadBlockId,
        ...options,
      });
    },
    [threadBlockId, postAsync]
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
  // The windowed replies hold the place from wherever a jump put the
  // reader (set below, once the windowing is set up).
  const takePlaceRef = useRef<(() => void) | null>(null);
  const jumpedRef = useBlockJump(scrollRef, undefined, () =>
    takePlaceRef.current?.()
  );

  // A long discussion renders only the replies near the view (see
  // useWindowedRows); a jump's target renders wherever it is. The finding's
  // latest change sits among the replies as a row of its own.
  const [searchParams] = useSearchParams();
  const jumpBlockId = searchParams.get(BLOCK_PARAM);
  const pinnedIds = useMemo(
    () => new Set(jumpBlockId ? [jumpBlockId] : []),
    [jumpBlockId]
  );
  const rowKeys = useMemo(() => {
    const keys = replies.map((reply) => reply.id);
    if (change) keys.splice(changeAt, 0, CHANGE_ROW_KEY);
    return keys;
  }, [replies, change, changeAt]);
  const fullHistory = useFullHistory();
  const windowed = useWindowedRows({
    scrollRef,
    enabled: !fullHistory,
    keys: rowKeys,
    align: "start",
    pinned: pinnedIds,
    cacheKey: `thread:${threadBlockId}`,
    anchorable: (key) => key !== CHANGE_ROW_KEY,
  });
  takePlaceRef.current = windowed.takePlace;
  const repliesById = useMemo(
    () => new Map(replies.map((reply, index) => [reply.id, { reply, index }])),
    [replies]
  );
  // Disclosures inside a reply outlive the reply scrolling out of view.
  const rowStates = useRef(new Map<string, ChatRowState>());
  const rowState = (id: string): ChatRowState => {
    let state = rowStates.current.get(id);
    if (!state) {
      state = new Map();
      rowStates.current.set(id, state);
    }
    return state;
  };
  const replyCount = thread.replies.length;
  const seenRepliesRef = useRef<{ blockId: string; count: number } | null>(
    null
  );
  const loadedRootId = thread.root?.id ?? null;
  useEffect(() => {
    // The page's first load is where it opens, not replies arriving: the
    // count to follow from is taken once the thread is here.
    if (loadedRootId !== threadBlockId) return;
    const el = scrollRef.current;
    const seen = seenRepliesRef.current;
    // A jump to a reply (see useBlockJump) that just landed with this
    // update keeps the reader on it; later replies scroll in as usual.
    const jump = jumpedRef.current;
    const jumped = jump !== null && Date.now() - jump.at < JUMP_HOLD_MS;
    if (!seen || seen.blockId !== threadBlockId) {
      seenRepliesRef.current = { blockId: threadBlockId, count: replyCount };
      if (el && !jumped) el.scrollTop = 0;
      return;
    }
    if (replyCount > seen.count && el && !jumped) {
      el.scrollTop = el.scrollHeight;
    }
    seen.count = replyCount;
  }, [replyCount, threadBlockId, loadedRootId, jumpedRef]);

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
      data-finding-id={findingId ?? undefined}
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
        className="stream-surfaces-flat min-h-0 flex-1 overflow-y-auto overscroll-contain py-2"
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
          <BlockView
            block={thread.root}
            grouped={false}
            ctx={ctx}
            answering={answeringBlockId === thread.root.id}
            submitting={submittingBlockId === thread.root.id}
            answersDisabled={disabledReason !== null}
            onAnswer={onAnswer}
            inThread
            threadRoot={blockId}
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
            <div
              ref={windowed.containerRef}
              {...windowed.containerProps}
              data-testid="chat-thread-replies"
            >
              {windowed.segments.flatMap((segment) =>
                segment.kind === "gap"
                  ? [<WindowGap key={segment.key} height={segment.height} />]
                  : rowKeys.slice(segment.from, segment.to).map((key) => {
                      if (key === CHANGE_ROW_KEY) {
                        return (
                          <div key={key} ref={windowed.measure(key)}>
                            {changeEntry}
                          </div>
                        );
                      }
                      const { reply, index } = repliesById.get(key)!;
                      return (
                        <div
                          key={key}
                          ref={windowed.measure(key)}
                          data-chat-entry-id={reply.id}
                          data-testid={
                            reply.turn ? "chat-thread-turn" : undefined
                          }
                          data-turn-id={reply.turn ? reply.id : undefined}
                        >
                          <ChatRowStateContext.Provider
                            value={rowState(reply.id)}
                          >
                            <BlockView
                              block={reply}
                              grouped={
                                // The change entry above breaks the run of posts.
                                index === changeAt
                                  ? false
                                  : (groupedById.get(reply.id) ?? false)
                              }
                              ctx={ctx}
                              answering={answeringBlockId === reply.id}
                              submitting={submittingBlockId === reply.id}
                              answersDisabled={disabledReason !== null}
                              onAnswer={onAnswer}
                              inThread
                            />
                          </ChatRowStateContext.Provider>
                        </div>
                      );
                    })
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
        <PermissionRequests agentId={agentId} active />
        <ChatComposer
          // No persisted draft: a thread's half-typed reply is not worth
          // keeping across reloads, and sharing the agent's key would
          // swap drafts with the main composer.
          agentId={null}
          onSend={onSend}
          canQueue
          uploadFile={uploadFile}
          disabledReason={disabledReason}
          sending={post.isPending}
          placeholder={
            finding ? "Comment on this finding…" : "Reply in thread…"
          }
          autoFocus={!isMobile}
          mentionables={mentionables}
        />
      </div>
    </aside>
  );
}
