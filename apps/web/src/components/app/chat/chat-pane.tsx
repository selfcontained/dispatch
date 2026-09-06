import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatFeedEntry, ChatQuestionOption } from "@dispatch/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, MessageSquare } from "lucide-react";

import { type ChatUserAttachmentInput } from "@/components/app/chat/chat-attachments";
import { ChatComposer } from "@/components/app/chat/chat-composer";
import { ChatPresenceStrip } from "@/components/app/chat/chat-presence-strip";
import {
  type FeedContext,
  type PeerDirectory,
  peerDirectory,
} from "@/components/app/chat/chat-entries";
import {
  arrivedEntryIds,
  ChatFeed,
  latestAgentMessageId,
  latestOpenFreeformQuestion,
  latestUserMessageId,
} from "@/components/app/chat/chat-feed";
import { useShortcutRunner } from "@/components/app/pin-shortcut-runner";
import { type Agent, type AgentPin } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import {
  useAnswerChatQuestion,
  useChatFeed,
  useMarkChatRead,
  useSendChatMessage,
} from "@/hooks/use-chat";
import { useInjectionHoldState } from "@/hooks/use-injection-hold-state";
import { useRunPinShortcut } from "@/hooks/use-pin-shortcuts";
import { api } from "@/lib/api";
import { uploadAgentMedia } from "@/lib/media-upload";
import { cn } from "@/lib/utils";

export type ChatPaneProps = {
  agentId: string | null;
  agent: Agent | null;
  terminalMode: "tmux" | "inert" | null;
  /**
   * The pane is on screen: its tab is active (or it sits in a split) and the
   * Agent pane is showing Chat rather than the Console. While false the
   * pane stays mounted — feed, scroll position and draft intact — but does
   * not mark anything read or take focus.
   */
  active: boolean;
  showChildAgents: boolean;
  childAgentIds: readonly string[];
  onShowChildAgentsChange: (show: boolean) => void;
  openLightbox: (mediaId: number) => void;
  /** Opens a review in the Reviews sidebar, expanded; from a review card. */
  onOpenReview?: (reviewId: number) => void;
  isMobile: boolean;
};

/** Remove both directions of the selected agent's child conversations. */
export function filterChildAgentMessages(
  entries: readonly ChatFeedEntry[],
  childAgentIds: ReadonlySet<string>,
  showChildAgents: boolean
): ChatFeedEntry[] {
  if (showChildAgents) return [...entries];
  return entries.filter(
    (entry) =>
      entry.type !== "agent_message" ||
      (!entry.involvesChildAgent &&
        !childAgentIds.has(entry.senderAgentId) &&
        !childAgentIds.has(entry.recipientAgentId))
  );
}

/** How close to the bottom (px) still counts as "following" the feed. */
const FOLLOW_THRESHOLD_PX = 48;

/**
 * Where a reader was in one agent's feed.
 *
 * ChatPane is keyed by agent id (see AgentPane), so switching agents
 * unmounts it and its scroll position goes with it: the feed always
 * reopened pinned to the newest message, and anyone reading back through
 * history had to walk down to their place again. This remembers the row
 * they were parked on instead.
 *
 * A module-level map rather than state or an atom: nothing re-renders when
 * it changes. It is read once at mount and written from a scroll handler,
 * and it is deliberately session-scoped — reopening the app should land on
 * the newest message, not on wherever yesterday ended.
 */
/** One row the feed can be put back against: which row, and where it sat. */
export type ChatScrollAnchor = {
  entryId: string;
  /** The row's top edge, relative to the top of the viewport. */
  offset: number;
};

export type ChatScrollPosition = {
  /** At the bottom on the way out: reopen following the feed. */
  following: boolean;
  /**
   * The rows on screen, top first. More than one because a row's id is not
   * guaranteed to survive: a run of consecutive `working` events renders as
   * a single status row carrying the newest event's id (see collapseFeed),
   * so a reader parked on a live agent's status line comes back to an id
   * that no longer exists. Whichever of these is still here wins.
   */
  anchors: ChatScrollAnchor[];
};

/** Bounded so a long session's agent hopping can't grow it without end. */
const SCROLL_MEMORY_LIMIT = 50;
const scrollPositions = new Map<string, ChatScrollPosition>();

export function rememberChatScrollPosition(
  agentId: string,
  position: ChatScrollPosition
): void {
  // Re-inserting makes this the newest key, so the eviction below drops the
  // agent nobody has looked at in longest.
  scrollPositions.delete(agentId);
  scrollPositions.set(agentId, position);
  if (scrollPositions.size > SCROLL_MEMORY_LIMIT) {
    const oldest = scrollPositions.keys().next();
    if (!oldest.done) scrollPositions.delete(oldest.value);
  }
}

export function readChatScrollPosition(
  agentId: string | null
): ChatScrollPosition | null {
  return agentId ? (scrollPositions.get(agentId) ?? null) : null;
}

/** Tests share the module with each other; let them start clean. */
export function clearChatScrollMemory(): void {
  scrollPositions.clear();
}

function entryNodes(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>("[data-chat-entry-id]")];
}

/** How many rows down from the fold are kept as fallback anchors. */
const ANCHOR_COUNT = 8;

/**
 * The rows on screen, starting with the first one not entirely above the
 * fold — what the reader is looking at — each with its top edge relative to
 * the top of the viewport. Measured from rects so it does not depend on the
 * offset parent.
 */
function visibleAnchors(el: HTMLElement): ChatScrollAnchor[] {
  const top = el.getBoundingClientRect().top;
  const anchors: ChatScrollAnchor[] = [];
  for (const node of entryNodes(el)) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom <= top) continue;
    const entryId = node.dataset.chatEntryId;
    if (entryId) anchors.push({ entryId, offset: rect.top - top });
    if (anchors.length === ANCHOR_COUNT) break;
  }
  return anchors;
}

/**
 * Puts the feed back against the first anchor that is still here. False
 * when none of them are — the reader's whole neighbourhood has gone.
 */
function scrollToAnchor(el: HTMLElement, anchors: ChatScrollAnchor[]): boolean {
  const nodes = entryNodes(el);
  for (const anchor of anchors) {
    const node = nodes.find((n) => n.dataset.chatEntryId === anchor.entryId);
    if (!node) continue;
    const delta =
      node.getBoundingClientRect().top -
      el.getBoundingClientRect().top -
      anchor.offset;
    el.scrollTop += delta;
    return true;
  }
  return false;
}

/**
 * How often the position is recorded while the feed is moving. Cheap
 * enough to be this frequent — the scan above measures 0.05ms on a 75-row
 * feed — and it bounds how much of a fling a switch mid-gesture can lose.
 */
export const REMEMBER_THROTTLE_MS = 50;

/** How long the feed must sit still before the final, exact record. */
export const REMEMBER_SETTLE_MS = 150;

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
  if (agent.status === "creating") return "The agent is still starting up.";
  if (agent.status !== "running") {
    return "The agent is not running. Start it to send messages.";
  }
  return null;
}

export function ChatPane({
  agentId,
  agent,
  terminalMode,
  active,
  showChildAgents,
  childAgentIds,
  onShowChildAgentsChange,
  openLightbox,
  onOpenReview,
  isMobile,
}: ChatPaneProps): JSX.Element {
  const feed = useChatFeed(agentId);
  const send = useSendChatMessage(agentId);
  const answer = useAnswerChatQuestion(agentId);
  const markRead = useMarkChatRead(agentId, feed.unreadCount);
  const holdState = useInjectionHoldState(agentId);

  const entries = feed.entries;
  const childAgentIdSet = useMemo(
    () => new Set(childAgentIds),
    [childAgentIds]
  );
  const visibleEntries = useMemo(
    () => filterChildAgentMessages(entries, childAgentIdSet, showChildAgents),
    [childAgentIdSet, entries, showChildAgents]
  );
  const heldMessageId = useMemo(
    () => (holdState?.held ? latestUserMessageId(entries) : null),
    [entries, holdState?.held]
  );
  // Status events alone are not a conversation: real agents always have
  // some, so the empty state must key off the entries a person wrote.
  const hasConversation = useMemo(
    () => visibleEntries.some((entry) => entry.type !== "status"),
    [visibleEntries]
  );
  const hasHiddenChildMessages = visibleEntries.length < entries.length;

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
  const savedPositionRef = useRef(readChatScrollPosition(agentId));
  const [following, setFollowing] = useState(
    () => savedPositionRef.current?.following ?? true
  );
  const [pendingBelow, setPendingBelow] = useState(false);
  const lastEntryIdRef = useRef<string | null>(null);
  const seenEntryIdsRef = useRef<ReadonlySet<string>>(new Set());
  const lastShowChildAgentsRef = useRef(showChildAgents);
  const olderLoadRef = useRef<{ height: number; top: number } | null>(null);
  const restoredRef = useRef(false);
  const rememberTimerRef = useRef<number | null>(null);
  const rememberedAtRef = useRef(0);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Reading every row's rect is too much to do on each scroll event, so
  // this is throttled rather than called from the handler directly.
  const remember = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !agentId) return;
    rememberedAtRef.current = Date.now();
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    rememberChatScrollPosition(agentId, {
      following: distance <= FOLLOW_THRESHOLD_PX,
      anchors: visibleAnchors(el),
    });
  }, [agentId]);

  // Throttled, and again once the feed settles. It has to keep recording
  // through a long scroll, not only at its ends: the pane can be unmounted
  // mid-fling, and measuring then is too late — React has detached the feed
  // by the time the cleanup runs and every row measures zero. So the worst
  // a switch-while-still-scrolling can cost is one throttle window of
  // movement, rather than the whole gesture.
  const rememberSoon = useCallback(() => {
    if (Date.now() - rememberedAtRef.current >= REMEMBER_THROTTLE_MS) {
      remember();
    }
    if (rememberTimerRef.current !== null) {
      window.clearTimeout(rememberTimerRef.current);
    }
    rememberTimerRef.current = window.setTimeout(() => {
      rememberTimerRef.current = null;
      remember();
    }, REMEMBER_SETTLE_MS);
  }, [remember]);

  useEffect(
    () => () => {
      if (rememberTimerRef.current !== null) {
        window.clearTimeout(rememberTimerRef.current);
      }
    },
    []
  );

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance <= FOLLOW_THRESHOLD_PX;
    setFollowing(atBottom);
    if (atBottom) setPendingBelow(false);
    rememberSoon();
  }, [rememberSoon]);

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
    const lastId = visibleEntries[visibleEntries.length - 1]?.id ?? null;
    // A live row is not always the last one: a status event can arrive
    // late and land by time below the newest row. Any unseen row sitting
    // under a seen one is an arrival; only "Load older" adds rows above.
    const arrived = arrivedEntryIds(seenEntryIdsRef.current, visibleEntries);
    seenEntryIdsRef.current = new Set(visibleEntries.map((e) => e.id));
    const filterChanged = lastShowChildAgentsRef.current !== showChildAgents;
    lastShowChildAgentsRef.current = showChildAgents;
    // Changing the filter can expose an older tail or remove the current one.
    // Adopt it before append detection so the filter itself does not
    // manufacture a “New messages” prompt or move the scroll position.
    if (filterChanged) {
      lastEntryIdRef.current = lastId;
      setPendingBelow(false);
      return;
    }
    const appended = lastId !== lastEntryIdRef.current || arrived.length > 0;
    lastEntryIdRef.current = lastId;
    if (!appended) return;
    // The feed's first rows: put the reader back where they left this
    // agent, or open at the newest when there is nowhere to go back to.
    if (!restoredRef.current) {
      restoredRef.current = true;
      const saved = savedPositionRef.current;
      const restored =
        saved !== null && !saved.following && scrollToAnchor(el, saved.anchors);
      if (restored) return;
      setFollowing(true);
      scrollToBottom();
      return;
    }
    if (following) {
      scrollToBottom();
    } else {
      setPendingBelow(true);
    }
  }, [following, scrollToBottom, showChildAgents, visibleEntries]);

  // Agent switch. AgentPane keys this pane by agent id, so in practice a
  // switch remounts it and the state above is already fresh; this covers
  // the same instance being handed a different agent.
  const shownAgentRef = useRef(agentId);
  useEffect(() => {
    if (shownAgentRef.current === agentId) return;
    shownAgentRef.current = agentId;
    savedPositionRef.current = readChatScrollPosition(agentId);
    restoredRef.current = false;
    setFollowing(savedPositionRef.current?.following ?? true);
    setPendingBelow(false);
    lastEntryIdRef.current = null;
    seenEntryIdsRef.current = new Set();
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
  // While a free-text question is open, what gets typed answers it —
  // attachments included, so the reply stays linked to the question.
  const onSend = useCallback(
    async (
      text: string,
      attachments: ChatUserAttachmentInput[]
    ): Promise<void> => {
      setSendError(null);
      setFollowing(true);
      if (replyTarget) {
        await answerAsync({
          messageId: replyTarget.id,
          value: text,
          attachments,
        });
        return;
      }
      await sendAsync({ text, attachments });
    },
    [answerAsync, replyTarget, sendAsync]
  );

  const uploadFile = useCallback(
    (file: File) => {
      if (!agentId) return Promise.reject(new Error("No agent selected."));
      return uploadAgentMedia(agentId, file, { source: "user", inject: false });
    },
    [agentId]
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
  // Shortcut pins in the stream fire exactly as they do in the sidebar:
  // same confirmation rule, same dialog, same focus restoration.
  const runPinShortcut = useRunPinShortcut();
  // As with `answer` above: the mutation result object is new every render,
  // and it fed `ctx`, so every memoised post re-rendered whenever the pane
  // did. Depend on the stable `mutate` and the flag instead.
  const { mutate: runShortcutNow, isPending: shortcutPending } = runPinShortcut;
  const fireShortcut = useCallback(
    (pin: AgentPin) => {
      if (!agentId || !pin.id || shortcutPending) return;
      runShortcutNow({ agentId, pinId: pin.id, label: pin.label });
    },
    [agentId, runShortcutNow, shortcutPending]
  );
  const shortcuts = useShortcutRunner(fireShortcut);
  const { request: requestShortcut, registerButton: registerShortcutButton } =
    shortcuts;
  const onRunShortcut = useCallback(
    (pin: AgentPin, pointerType?: string) =>
      requestShortcut(pin, pointerType, null),
    [requestShortcut]
  );
  const pendingPinId = runPinShortcut.isPending
    ? (runPinShortcut.variables?.pinId ?? null)
    : null;
  const agentIsRunning = agent?.status === "running";
  // The sidebar's agent list, read for a peer post's icon and lineage.
  // `select` narrows it to what the feed shows, so structural sharing keeps
  // the directory's identity across agent updates that change nothing here.
  // A stable selector lets react-query hand back the previous selected value
  // directly; an inline one is re-run and deep-compared on every render
  // (the result's identity is preserved either way, this only skips work).
  const selectPeers = useCallback(
    (agents: Agent[]) => peerDirectory(agentId ?? "", agents),
    [agentId]
  );
  const { data: peers } = useQuery<Agent[], Error, PeerDirectory>({
    queryKey: ["agents"],
    queryFn: async () => {
      const payload = await api<{ agents: Agent[] }>("/api/v1/agents");
      return payload.agents;
    },
    select: selectPeers,
  });
  const ctx = useMemo<FeedContext>(
    () => ({
      agentId: agentId ?? "",
      agentName: agent?.name,
      agentType: agent?.type ?? null,
      peers,
      pins,
      workspaceRoot: agent?.worktreePath ?? agent?.cwd ?? null,
      onRunShortcut,
      registerShortcutButton,
      pendingPinId,
      agentIsRunning,
      onOpenMedia: openLightbox,
      onOpenReview,
    }),
    [
      agent?.cwd,
      agent?.name,
      agent?.type,
      agent?.worktreePath,
      agentId,
      agentIsRunning,
      onOpenReview,
      onRunShortcut,
      openLightbox,
      peers,
      pendingPinId,
      pins,
      registerShortcutButton,
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
      className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden bg-background"
      data-testid="chat-pane"
    >
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          data-testid="chat-scroll"
          onScroll={onScroll}
          // Images in the feed size themselves after they load; keep the
          // bottom pinned when that happens while following.
          onLoadCapture={() => {
            if (following) scrollToBottom();
          }}
          className="h-full min-w-0 max-w-full overflow-x-hidden overflow-y-auto overscroll-contain py-2"
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
                visibleEntries.length === 0 ? "h-full" : "mb-4 py-6"
              )}
              data-testid="chat-empty"
            >
              <MessageSquare className="h-8 w-8" />
              {hasHiddenChildMessages ? (
                <>
                  <div className="text-foreground">
                    Child-agent messages are hidden.
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    className="h-7 text-xs"
                    onClick={() => onShowChildAgentsChange(true)}
                  >
                    Show child agents
                  </Button>
                </>
              ) : agent ? (
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
          {visibleEntries.length > 0 ? (
            <ChatFeed
              entries={visibleEntries}
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
          "min-w-0 max-w-full shrink-0 overflow-hidden border-t border-border/40 px-4 pt-2",
          isMobile ? "pb-2" : "pb-3"
        )}
      >
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <ChatPresenceStrip agentId={agentId} agent={agent} />
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
          agentId={agentId}
          onSend={onSend}
          uploadFile={uploadFile}
          disabledReason={disabledReason}
          sending={send.isPending || answer.isPending}
          autoFocus={active && !isMobile}
          replyContext={replyContext}
        />
      </div>
      {shortcuts.dialog}
    </div>
  );
}
