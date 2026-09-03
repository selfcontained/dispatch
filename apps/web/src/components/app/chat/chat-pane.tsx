import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatQuestionOption } from "@dispatch/shared";
import { ArrowDown, Hash, MessageSquare, TerminalSquare } from "lucide-react";

import { describeAgentStatus } from "@/components/app/agent-event-utils";
import { ChatComposer } from "@/components/app/chat/chat-composer";
import { type FeedContext } from "@/components/app/chat/chat-entries";
import {
  ChatFeed,
  latestAgentMessageId,
  latestOpenFreeformQuestion,
  latestUserMessageId,
} from "@/components/app/chat/chat-feed";
import {
  type Agent,
  type AgentPin,
  type MediaFile,
} from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  useAnswerChatQuestion,
  useChatFeed,
  useMarkChatRead,
  useSendChatMessage,
} from "@/hooks/use-chat";
import { useInjectionHoldState } from "@/hooks/use-injection-hold-state";
import { cn } from "@/lib/utils";

export type ChatPaneProps = {
  agentId: string | null;
  agent: Agent | null;
  terminalMode: "tmux" | "inert" | null;
  /** The pane is on screen (its tab is active, or it sits in a split). */
  active: boolean;
  onOpenConsole: () => void;
  openLightbox: (file: MediaFile) => void;
  isMobile: boolean;
};

/** How close to the bottom (px) still counts as "following" the feed. */
const FOLLOW_THRESHOLD_PX = 48;

/** First line of a question, plain enough for a one-line chip. */
export function questionExcerpt(text: string, max = 80): string {
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
      .find((l) => l.length > 0) ?? "";
  const plain = line.replace(/[*_`]/g, "");
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

function composerDisabledReason(
  agent: Agent | null,
  terminalMode: "tmux" | "inert" | null,
  feed: { isLoading: boolean; error: Error | null } = {
    isLoading: false,
    error: null,
  }
): string | null {
  if (!agent) return "Select an agent to chat with.";
  if (feed.error) return "Chat couldn't load — retry above before sending.";
  if (feed.isLoading) return "Loading the chat…";
  if (terminalMode === "inert") {
    return "This agent runs in inert mode, so there is no terminal to deliver messages to.";
  }
  if (agent.status === "creating") return "The agent is still starting up.";
  if (agent.status !== "running") {
    return "The agent is not running. Start it to send messages.";
  }
  return null;
}

function PresenceLine({ agent }: { agent: Agent | null }): JSX.Element | null {
  if (!agent) return null;
  const { label, colorClass } = describeAgentStatus(
    agent,
    agent.status !== "running"
  );
  const message =
    agent.status === "running" ? agent.latestEvent?.message?.trim() : "";
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
      data-testid="chat-presence"
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full bg-current",
          colorClass
        )}
      />
      <span className={cn("shrink-0 font-medium", colorClass)}>{label}</span>
      {message ? (
        <>
          <span className="shrink-0">·</span>
          <span className="truncate">{message}</span>
        </>
      ) : null}
    </div>
  );
}

export function ChatPane({
  agentId,
  agent,
  terminalMode,
  active,
  onOpenConsole,
  openLightbox,
  isMobile,
}: ChatPaneProps): JSX.Element {
  const feed = useChatFeed(agentId);
  const send = useSendChatMessage(agentId);
  const answer = useAnswerChatQuestion(agentId);
  const markRead = useMarkChatRead(agentId, feed.unreadCount);
  const holdState = useInjectionHoldState(agentId);

  const entries = feed.entries;
  const heldMessageId = useMemo(
    () => (holdState?.held ? latestUserMessageId(entries) : null),
    [entries, holdState?.held]
  );
  // Status events alone are not a conversation: real agents always have
  // some, so the empty state must key off the entries a person wrote.
  const hasConversation = useMemo(
    () => entries.some((entry) => entry.type !== "status"),
    [entries]
  );

  // A typed reply answers the newest open free-text question unless the
  // user has opted out of that question with the chip's ×.
  const openQuestion = useMemo(
    () => latestOpenFreeformQuestion(entries),
    [entries]
  );
  const [dismissedQuestionId, setDismissedQuestionId] = useState<string | null>(
    null
  );
  const replyTarget =
    openQuestion && openQuestion.id !== dismissedQuestionId
      ? openQuestion
      : null;

  // ---- scroll: follow the bottom unless the user scrolled up ---------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [pendingBelow, setPendingBelow] = useState(false);
  const lastEntryIdRef = useRef<string | null>(null);
  const olderLoadRef = useRef<{ height: number; top: number } | null>(null);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance <= FOLLOW_THRESHOLD_PX;
    setFollowing(atBottom);
    if (atBottom) setPendingBelow(false);
  }, []);

  const { loadOlder: fetchOlder } = feed;
  const loadOlder = useCallback(() => {
    const el = scrollRef.current;
    if (el)
      olderLoadRef.current = { height: el.scrollHeight, top: el.scrollTop };
    fetchOlder();
  }, [fetchOlder]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Older page landed above: keep what the user was reading in place.
    const anchor = olderLoadRef.current;
    if (anchor && el.scrollHeight > anchor.height) {
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
      olderLoadRef.current = null;
      return;
    }
    const lastId = entries[entries.length - 1]?.id ?? null;
    const appended = lastId !== lastEntryIdRef.current;
    lastEntryIdRef.current = lastId;
    if (!appended) return;
    if (following) {
      scrollToBottom();
    } else {
      setPendingBelow(true);
    }
  }, [entries, following, scrollToBottom]);

  // Agent switch: start at the bottom again.
  useEffect(() => {
    setFollowing(true);
    setPendingBelow(false);
    lastEntryIdRef.current = null;
    olderLoadRef.current = null;
  }, [agentId]);

  useEffect(() => {
    if (active && following) scrollToBottom();
  }, [active, following, scrollToBottom]);

  // ---- unread: mark read while visible and focused --------------------------
  // markRead itself is a no-op while nothing is unread.
  const upTo = latestAgentMessageId(entries);
  useEffect(() => {
    if (!active) return;
    const attempt = () => {
      if (document.hidden) return;
      if (typeof document.hasFocus === "function" && !document.hasFocus()) {
        return;
      }
      markRead(upTo ?? undefined);
    };
    attempt();
    window.addEventListener("focus", attempt);
    document.addEventListener("visibilitychange", attempt);
    return () => {
      window.removeEventListener("focus", attempt);
      document.removeEventListener("visibilitychange", attempt);
    };
  }, [active, markRead, upTo]);

  // ---- actions --------------------------------------------------------------
  const [sendError, setSendError] = useState<string | null>(null);

  // The composer keeps its draft until this resolves; failures surface in
  // the composer itself, so nothing is set here on error. The mutate
  // functions are stable, unlike the mutation result objects, so these
  // callbacks survive the re-renders every status event causes.
  const { mutateAsync: answerAsync, mutate: answerNow } = answer;
  const { mutateAsync: sendAsync } = send;
  const onSend = useCallback(
    async (text: string): Promise<void> => {
      setSendError(null);
      setFollowing(true);
      if (replyTarget) {
        await answerAsync({ messageId: replyTarget.id, value: text });
        return;
      }
      await sendAsync(text);
    },
    [answerAsync, replyTarget, sendAsync]
  );

  const replyContext = useMemo(
    () =>
      replyTarget
        ? {
            excerpt: questionExcerpt(replyTarget.text),
            onDismiss: () => setDismissedQuestionId(replyTarget.id),
          }
        : null,
    [replyTarget]
  );

  const onAnswer = useCallback(
    (messageId: string, option: ChatQuestionOption) => {
      setSendError(null);
      setFollowing(true);
      answerNow(
        {
          messageId,
          value: option.value ?? option.label,
          label: option.label,
        },
        { onError: (err) => setSendError(err.message) }
      );
    },
    [answerNow]
  );

  // Every agent.upsert hands over a fresh pins array; key the context on its
  // content so unchanged pins don't invalidate every memoised post.
  const pinsKey = JSON.stringify(agent?.pins ?? []);
  const pins = useMemo<AgentPin[]>(() => JSON.parse(pinsKey), [pinsKey]);
  const ctx = useMemo<FeedContext>(
    () => ({
      agentId: agentId ?? "",
      agentName: agent?.name,
      agentType: agent?.type ?? null,
      pins,
      workspaceRoot: agent?.worktreePath ?? agent?.cwd ?? null,
      onOpenMedia: openLightbox,
    }),
    [
      agent?.cwd,
      agent?.name,
      agent?.type,
      agent?.worktreePath,
      agentId,
      openLightbox,
      pins,
    ]
  );

  const disabledReason = composerDisabledReason(agent, terminalMode, {
    isLoading: feed.isLoading,
    error: feed.error,
  });
  const answeringMessageId = answer.isPending
    ? (answer.variables?.messageId ?? null)
    : null;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="chat-pane"
    >
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border/40 px-3">
        <span className="flex min-w-0 items-center gap-1 text-xs font-medium text-foreground">
          <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{agent?.name ?? "Chat"}</span>
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-2 text-xs text-muted-foreground"
          onClick={onOpenConsole}
          data-testid="chat-open-console"
        >
          <TerminalSquare className="h-3.5 w-3.5" />
          Open Console
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          // Images in the feed size themselves after they load; keep the
          // bottom pinned when that happens while following.
          onLoadCapture={() => {
            if (following) scrollToBottom();
          }}
          className="h-full overflow-y-auto overscroll-contain py-2"
        >
          {feed.hasOlder ? (
            <div className="mb-1 flex justify-center px-4">
              <Button
                type="button"
                size="sm"
                variant="default"
                className="h-7 text-xs"
                onClick={loadOlder}
                disabled={feed.isFetchingOlder}
              >
                {feed.isFetchingOlder ? "Loading…" : "Load older"}
              </Button>
            </div>
          ) : null}
          {feed.error ? (
            <div
              role="alert"
              className="mx-4 mb-3 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              data-testid="chat-feed-error"
            >
              <span className="min-w-0 truncate">
                Couldn&apos;t load the chat: {feed.error.message}
              </span>
              <Button
                type="button"
                size="sm"
                variant="default"
                className="h-6 shrink-0 px-2 text-xs"
                onClick={feed.refetch}
                data-testid="chat-feed-retry"
              >
                Retry
              </Button>
            </div>
          ) : null}
          {!feed.isLoading && !hasConversation && !feed.error ? (
            <div
              className={cn(
                "flex flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground",
                entries.length === 0 ? "h-full" : "mb-4 py-6"
              )}
              data-testid="chat-empty"
            >
              <MessageSquare className="h-8 w-8" />
              {agent ? (
                <>
                  <div className="text-foreground">
                    No messages yet. Send the first one below and the agent
                    replies here.
                  </div>
                  <div className="max-w-md text-xs">
                    Agents launched before Chat was enabled won&apos;t have the
                    Chat guidance until they are relaunched; until then their
                    replies only show in the Console.
                  </div>
                </>
              ) : (
                <div>Select an agent to start chatting.</div>
              )}
            </div>
          ) : null}
          {entries.length > 0 ? (
            <ChatFeed
              entries={entries}
              ctx={ctx}
              heldMessageId={heldMessageId}
              answeringMessageId={answeringMessageId}
              answersDisabled={disabledReason !== null}
              onAnswer={onAnswer}
            />
          ) : null}
        </div>
        {pendingBelow && !following ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="pointer-events-auto h-7 gap-1 rounded-full text-xs shadow"
              onClick={() => {
                setFollowing(true);
                setPendingBelow(false);
                scrollToBottom("smooth");
              }}
            >
              <ArrowDown className="h-3 w-3" />
              New messages
            </Button>
          </div>
        ) : null}
      </div>

      <div
        className={cn(
          "shrink-0 border-t border-border/40 px-4 pt-2",
          isMobile ? "pb-2" : "pb-3"
        )}
      >
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <PresenceLine agent={agent} />
          {sendError ? (
            <span
              role="alert"
              className="truncate text-[11px] text-destructive"
            >
              {sendError}
            </span>
          ) : null}
        </div>
        <ChatComposer
          onSend={onSend}
          disabledReason={disabledReason}
          sending={send.isPending || answer.isPending}
          autoFocus={active && !isMobile}
          replyContext={replyContext}
        />
      </div>
    </div>
  );
}
