import { ConversationReturnLink } from "./chat/conversation-location-link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { BlockView, type FeedContext } from "./chat/chat-entries";
import { ChatFeed } from "./chat/chat-feed";
import { visibleStreamEntries } from "./chat/chat-pane";
import { AgentChatNavigation } from "./agent-chat-navigation";
import { FileLightbox } from "./file-lightbox";
import { Button } from "@/components/ui/button";
import { useAgentRecord } from "@/hooks/use-agent-tree";
import { useBlockJump } from "@/hooks/use-block-jump";
import { useStreamFeed, useThread } from "@/hooks/use-stream";

const NO_ANSWER = () => {};

/** Historical content only: no composer, delivery, mutation or session controls. */
export function ArchivedConversation({
  agentId,
  name,
  type,
}: {
  agentId: string;
  name: string;
  type: string;
}) {
  const [params, setParams] = useSearchParams();
  const threadId = params.get("thread");
  const findingId = threadId ? params.get("finding") : null;
  const targetId = params.get("block");
  const record = useAgentRecord(agentId);
  const feed = useStreamFeed(threadId ? null : agentId);
  const thread = useThread(agentId, findingId ?? threadId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fileId, setFileId] = useState<number | null>(null);
  const [fileIds, setFileIds] = useState<number[]>([]);
  const onOpenFile = useCallback((id: number, order?: number[]) => {
    setFileId(id);
    setFileIds(order ?? [id]);
  }, []);
  const onOpenThread = useCallback(
    (id: string, finding?: string) => {
      setParams((old) => {
        const next = new URLSearchParams(old);
        next.set("thread", id);
        next.delete("block");
        if (finding) next.set("finding", finding);
        else next.delete("finding");
        return next;
      });
    },
    [setParams]
  );
  const ctx = useMemo<FeedContext>(
    () => ({
      agentId,
      rootId: agentId,
      agentName: name,
      agentType: type,
      names: threadId ? thread.agentNames : feed.agentNames,
      readOnly: true,
      onOpenFile,
      onOpenThread,
    }),
    [
      agentId,
      name,
      type,
      threadId,
      thread.agentNames,
      feed.agentNames,
      onOpenFile,
      onOpenThread,
    ]
  );
  const entries = useMemo(
    () => visibleStreamEntries(feed.entries, null, true),
    [feed.entries]
  );
  useBlockJump(scrollRef);
  // Block-only deep links may refer to an older feed page.
  useEffect(() => {
    if (
      threadId ||
      !targetId ||
      feed.isLoading ||
      feed.isFetchingOlder ||
      !feed.hasOlder
    )
      return;
    if (!feed.entries.some((entry) => entry.id === targetId))
      void feed.loadOlder();
  }, [threadId, targetId, feed]);
  const error = threadId ? thread.error : feed.error;
  const loading = threadId ? thread.isLoading : feed.isLoading;
  const back = () =>
    setParams((old) => {
      const next = new URLSearchParams(old);
      if (findingId) next.delete("finding");
      else next.delete("thread");
      next.delete("block");
      return next;
    });
  return (
    <section
      className="min-w-0 space-y-2"
      aria-label="Archived conversation"
      data-testid="archived-conversation"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          Conversation{" "}
          <span className="text-xs text-muted-foreground">Read only</span>
        </h3>
        {threadId ? (
          <Button variant="ghost" size="sm" onClick={back}>
            {findingId ? "Back to review" : "Back to conversation"}
          </Button>
        ) : null}
      </div>
      {threadId ? <ConversationReturnLink inDrawer /> : null}
      <AgentChatNavigation
        agentId={agentId}
        parentId={record?.parentAgentId ?? null}
      />
      <div
        ref={scrollRef}
        className="stream-surfaces-flat h-[min(65vh,48rem)] min-h-64 overflow-y-auto rounded-lg border border-border py-2"
        data-testid="archived-conversation-scroll"
      >
        {loading ? (
          <p className="p-4 text-sm text-muted-foreground">
            Loading conversation…
          </p>
        ) : null}
        {error ? (
          <div role="alert" className="p-4 text-sm">
            Couldn&apos;t load conversation.{" "}
            <Button
              variant="ghost"
              onClick={() => (threadId ? thread.refetch() : feed.refetch())}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {threadId ? (
          thread.root ? (
            [thread.root, ...thread.replies].map((block) => (
              <div key={block.id} data-chat-entry-id={block.id}>
                <BlockView
                  block={block}
                  ctx={ctx}
                  grouped={false}
                  answering={false}
                  answersDisabled
                  onAnswer={NO_ANSWER}
                  inThread
                  threadRoot={threadId}
                  highlightFindingId={findingId}
                />
              </div>
            ))
          ) : null
        ) : (
          <>
            {feed.hasOlder ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void feed.loadOlder()}
                disabled={feed.isFetchingOlder}
              >
                Load older messages
              </Button>
            ) : null}
            <ChatFeed
              entries={entries}
              ctx={ctx}
              answeringBlockId={null}
              answersDisabled
              onAnswer={NO_ANSWER}
            />
            {!loading && !error && entries.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No conversation recorded.
              </p>
            ) : null}
          </>
        )}
      </div>
      <FileLightbox fileId={fileId} fileIds={fileIds} setFileId={setFileId} />
    </section>
  );
}
