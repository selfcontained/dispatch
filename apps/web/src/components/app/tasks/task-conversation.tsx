import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BlockOption } from "@dispatch/shared";
import { ArrowLeft, MessageSquare } from "lucide-react";
import type { ChatUserAttachmentInput } from "@/components/app/chat/chat-attachments";
import type { BlockStatePatch } from "@/components/app/chat/block-bodies";
import { ChatComposer } from "@/components/app/chat/chat-composer";
import {
  ChatFeed,
  entryGrowthKey,
  latestAgentBlockId,
} from "@/components/app/chat/chat-feed";
import { newestTurnEntry } from "@/components/app/chat/turn/turn-feed";
import { isMainColumnEntry } from "@/components/app/chat/chat-pane";
import { agentDisplayName } from "@/components/app/chat/chat-entries";
import { composerDisabledReason } from "@/components/app/chat/composer-disabled";
import { useChatFeedContext } from "@/components/app/chat/use-chat-feed-context";
import { ThreadPage } from "@/components/app/drawer/thread-page";
import { FileLightbox } from "@/components/app/file-lightbox";
import type { Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { useDeliveryAgents } from "@/hooks/use-agent-tree";
import {
  useAnswerQuestion,
  useMarkStreamRead,
  usePostBlock,
  useRetryDelivery,
  useSetBlockState,
  useStreamFeed,
  useSubmitForm,
  useToggleReaction,
} from "@/hooks/use-stream";
import { uploadAgentFile } from "@/lib/file-upload";
import { taskMentionables } from "./task-utils";

/** How close to the bottom still counts as reading the newest post. */
const FOLLOW_PX = 80;

/**
 * The task's own conversation: the stream rooted at the task id. A post
 * with no recipient goes to the assignee; a thread opens in place, over
 * the feed, with a way back.
 */
export function TaskConversation({
  taskId,
  active,
  assignee,
  isMobile,
  memberIds,
}: {
  taskId: string;
  /** Hidden tabs retain the composer but must not read or follow the feed. */
  active: boolean;
  assignee: Agent | null;
  isMobile: boolean;
  /** The task's agents: whom a post here can @mention. */
  memberIds: readonly string[];
}) {
  const feed = useStreamFeed(taskId);
  const send = usePostBlock(taskId);
  const answer = useAnswerQuestion(taskId);
  const submitForm = useSubmitForm(taskId);
  const setBlockState = useSetBlockState(taskId);
  const reaction = useToggleReaction(taskId);
  const retry = useRetryDelivery(taskId);
  const markRead = useMarkStreamRead(taskId, feed.unreadCount);
  const deliveryAgents = useDeliveryAgents();
  // A review's finding opens as its own thread: keep both ids, or replies
  // land on the review instead of the finding.
  const [thread, setThread] = useState<{
    blockId: string;
    findingId: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileId, setFileId] = useState<number | null>(null);
  const [fileIds, setFileIds] = useState<number[]>([]);
  const openLightbox = useCallback((id: number, order?: number[]) => {
    setFileId(id);
    setFileIds(order ?? [id]);
  }, []);

  const entries = useMemo(
    () => feed.entries.filter(isMainColumnEntry),
    [feed.entries]
  );

  const { mutate: answerNow } = answer;
  const onAnswer = useCallback(
    (
      blockId: string,
      option: BlockOption,
      attachments?: ChatUserAttachmentInput[]
    ) => {
      setError(null);
      answerNow(
        {
          blockId,
          value: option.value ?? option.label,
          label: option.label,
          ...(attachments?.length ? { attachments } : {}),
        },
        { onError: (err) => setError(err.message) }
      );
    },
    [answerNow]
  );
  const { mutate: submitNow } = submitForm;
  const onSubmitForm = useCallback(
    (blockId: string, values: Record<string, string | number | boolean>) => {
      setError(null);
      submitNow(
        { blockId, values },
        { onError: (err) => setError(err.message) }
      );
    },
    [submitNow]
  );
  const { mutate: setStateNow } = setBlockState;
  const onSetBlockState = useCallback(
    (blockId: string, patch: BlockStatePatch) => {
      setError(null);
      setStateNow(
        { blockId, state: patch },
        { onError: (err) => setError(err.message) }
      );
    },
    [setStateNow]
  );
  const { mutate: reactNow } = reaction;
  const onToggleReaction = useCallback(
    (blockId: string, emoji: string, remove: boolean) => {
      setError(null);
      reactNow(
        { blockId, emoji, remove },
        { onError: (err) => setError(err.message) }
      );
    },
    [reactNow]
  );
  const { mutate: retryNow } = retry;
  const onRetryDelivery = useCallback(
    (blockId: string) => {
      setError(null);
      retryNow(blockId, {
        onError: (err) =>
          setError(`Couldn't send that message again: ${err.message}`),
      });
    },
    [retryNow]
  );
  const retrying = useMemo(
    () => new Set(retry.isPending && retry.variables ? [retry.variables] : []),
    [retry.isPending, retry.variables]
  );
  const onOpenThread = useCallback(
    (blockId: string, findingId?: string) =>
      setThread({ blockId, findingId: findingId ?? null }),
    []
  );

  const { ctx } = useChatFeedContext({
    agentId: assignee?.id ?? null,
    rootId: taskId,
    agent: assignee,
    openLightbox,
    onToggleReaction,
    onOpenThread,
    onSubmitForm,
    onSetBlockState,
    settingBlockStateId: setBlockState.isPending
      ? (setBlockState.variables?.blockId ?? null)
      : null,
    onRetryDelivery,
    retrying,
    agentNames: feed.agentNames,
  });
  // The server names the task's agents, not the assignee's tree.
  const mentionables = useMemo(
    () => taskMentionables(memberIds, deliveryAgents),
    [memberIds, deliveryAgents]
  );

  // Follow the newest post unless the reader scrolled up to read. A turn
  // grows in place under one id, so follow its growth key (the newest
  // live turn's too, when a later post sits under it), and whatever else
  // changes the content's height (an image sizing itself).
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const last = entries[entries.length - 1];
  const liveTurn = newestTurnEntry(entries);
  const growthKey = [
    last ? entryGrowthKey(last) : "",
    liveTurn && !liveTurn.block.turn?.settled ? entryGrowthKey(liveTurn) : "",
  ].join("|");
  const followBottom = useCallback(() => {
    const el = scrollRef.current;
    if (active && el && el.clientHeight > 0 && followingRef.current)
      el.scrollTop = el.scrollHeight;
  }, [active]);
  useLayoutEffect(followBottom, [followBottom, growthKey, thread]);
  useEffect(() => {
    const el = contentRef.current;
    if (!active || !el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(followBottom);
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, followBottom, thread]);
  const onScroll = () => {
    const el = scrollRef.current;
    // display:none can reset scrollTop and emit a scroll at zero height.
    // Keep the reader's follow choice until the pane is visible again.
    if (active && el && el.clientHeight > 0)
      followingRef.current =
        el.scrollHeight - el.clientHeight - el.scrollTop <= FOLLOW_PX;
  };

  const upTo = latestAgentBlockId(feed.entries);
  useEffect(() => {
    if (active && !document.hidden) markRead(upTo ?? undefined);
  }, [active, markRead, upTo]);

  const { mutateAsync: sendAsync } = send;
  const onSend = useCallback(
    async (
      text: string,
      attachments: ChatUserAttachmentInput[],
      options?: { delivery?: "auto" | "queue" | "interrupt" }
    ) => {
      setError(null);
      followingRef.current = true;
      await sendAsync({
        text,
        attachments,
        ...(options?.delivery ? { delivery: options.delivery } : {}),
      });
    },
    [sendAsync]
  );
  const uploadFile = assignee
    ? (file: File) =>
        uploadAgentFile(assignee.id, file, { source: "user", inject: false })
    : undefined;
  // An answer goes to the question's author, not the assignee: only an
  // unready feed holds it back, never who the task is assigned to now.
  const feedReason = feed.error
    ? "The conversation couldn't load — retry above."
    : feed.isLoading
      ? "Loading the conversation…"
      : null;
  const answersDisabled = feedReason !== null;
  const disabledReason = assignee
    ? composerDisabledReason(assignee, feed)
    : "Assign an agent to start the conversation.";

  return (
    <div
      data-testid="task-conversation"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl bg-card shadow-sm ring-1 ring-border/40"
    >
      {thread ? (
        <>
          <div className="flex shrink-0 items-center gap-1 border-b border-border/40 px-1.5 py-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => setThread(null)}
            >
              <ArrowLeft className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              Conversation
            </Button>
          </div>
          <div className="flex min-h-0 flex-1">
            <ThreadPage
              key={`${thread.blockId}:${thread.findingId ?? ""}`}
              agentId={assignee?.id ?? taskId}
              agent={assignee}
              rootId={taskId}
              blockId={thread.blockId}
              findingId={thread.findingId}
              isMobile={isMobile}
              openLightbox={openLightbox}
              onOpenThread={onOpenThread}
              onBack={() => setThread(null)}
              mentionables={mentionables}
              // Thread replies follow the thread's sides and answers go to
              // the asker, so neither waits on an assignee.
              disabledReason={feedReason}
            />
          </div>
        </>
      ) : (
        <>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            data-testid="task-conversation-scroll"
            className="stream-surfaces-flat min-h-0 flex-1 overflow-y-auto overscroll-contain py-2"
          >
            <div ref={contentRef}>
              {feed.error ? (
                <div
                  role="alert"
                  className="mx-3 flex items-center justify-between gap-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                  <span className="min-w-0 truncate">
                    Couldn&apos;t load the conversation: {feed.error.message}
                  </span>
                  <Button
                    size="sm"
                    className="h-6 shrink-0 px-2 text-xs"
                    onClick={feed.refetch}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}
              {feed.hasOlder ? (
                <div className="mb-1 flex justify-center">
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={feed.loadOlder}
                    disabled={feed.isFetchingOlder}
                  >
                    {feed.isFetchingOlder ? "Loading…" : "Load older"}
                  </Button>
                </div>
              ) : null}
              {!feed.isLoading && !feed.error && entries.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-6 text-center text-xs text-muted-foreground">
                  <MessageSquare className="h-6 w-6" aria-hidden="true" />
                  {assignee
                    ? `Nothing here yet. A message goes to ${assignee.name}.`
                    : "Nothing here yet. Assign an agent to start."}
                </div>
              ) : null}
              {entries.length > 0 ? (
                <ChatFeed
                  entries={entries}
                  ctx={ctx}
                  answeringBlockId={
                    answer.isPending
                      ? (answer.variables?.blockId ?? null)
                      : null
                  }
                  submittingBlockId={
                    submitForm.isPending
                      ? (submitForm.variables?.blockId ?? null)
                      : null
                  }
                  answersDisabled={answersDisabled}
                  onAnswer={onAnswer}
                />
              ) : null}
            </div>
          </div>
          <div className="shrink-0 border-t border-border/40 bg-card px-2 pb-2 pt-2 md:px-3">
            {error ? (
              <div
                role="alert"
                className="mb-1.5 truncate text-[11px] text-destructive"
              >
                {error}
              </div>
            ) : null}
            <ChatComposer
              // Keyed by the task: the draft follows the task, not the agent.
              agentId={taskId}
              onSend={onSend}
              uploadFile={uploadFile}
              disabledReason={disabledReason}
              sending={send.isPending}
              placeholder="Message the task…"
              autoFocus={false}
              mentionables={mentionables}
              defaultRecipients={
                assignee
                  ? [
                      {
                        id: assignee.id,
                        name: agentDisplayName(assignee.id, ctx),
                      },
                    ]
                  : undefined
              }
              canQueue={Boolean(assignee)}
              deliveryAgents={deliveryAgents}
              conversation={{ streamId: taskId, threadId: null }}
            />
          </div>
        </>
      )}
      <FileLightbox fileId={fileId} fileIds={fileIds} setFileId={setFileId} />
    </div>
  );
}
