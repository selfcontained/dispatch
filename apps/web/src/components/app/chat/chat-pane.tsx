import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatTurnEntry, BlockOption, StreamEntry } from "@dispatch/shared";
import { MotionConfig } from "framer-motion";
import { ArrowDown, MessageSquare } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { type ChatUserAttachmentInput } from "@/components/app/chat/chat-attachments";
import { StopTurnButton } from "@/components/app/chat/stop-turn-button";
import { ChatComposer } from "@/components/app/chat/chat-composer";
import type { BlockStatePatch } from "@/components/app/chat/block-bodies";
import {
  arrivedEntryIds,
  ChatFeed,
  latestAgentBlockId,
  latestOpenFreeformQuestion,
  entryGrowthKey,
} from "@/components/app/chat/chat-feed";
import { ThreadPanel } from "@/components/app/chat/thread-panel";
import { TasksStrip } from "@/components/app/chat/turn/tasks-strip";
import {
  latestTurnPlan,
  newestTurnEntry,
} from "@/components/app/chat/turn/turn-feed";
import { useChatFeedContext } from "@/components/app/chat/use-chat-feed-context";
import { type Agent } from "@/components/app/types";
import { Button } from "@/components/ui/button";
import { useDescendantAgentIds, useRootAgentId } from "@/hooks/use-agent-tree";
import {
  useAnswerQuestion,
  useMarkStreamRead,
  usePostBlock,
  useSetBlockState,
  useStreamFeed,
  useSubmitForm,
  useToggleReaction,
} from "@/hooks/use-stream";
import { FINDING_PARAM, THREAD_PARAM } from "@/lib/agent-routes";
import { uploadAgentMedia } from "@/lib/media-upload";
import { cn } from "@/lib/utils";

export type ChatPaneProps = {
  agentId: string | null;
  agent: Agent | null;
  /**
   * The pane is on screen: its tab is active (or it sits in a split). While false the
   * pane stays mounted — feed, scroll position and draft intact — but does
   * not mark anything read or take focus.
   */
  active: boolean;
  /** Show the turns and posts of the agents under this one (default on). */
  showChildAgents: boolean;
  onShowChildAgentsChange: (show: boolean) => void;
  openLightbox: (mediaId: number) => void;
  /** Opens the Changes tab on a file (a review finding's path). */
  onOpenPath?: (path: string, line: number | null) => void;
  isMobile: boolean;
};

/**
 * One agent's page onto its root's stream. The stream carries the turns
 * and posts of every agent in the root's tree; the page shows what is the
 * agent's own, folds what belongs to the agents under it, and drops the
 * rest (a sibling's work, on a child's page).
 */
export type StreamView = {
  /** The agent whose page this is. */
  agentId: string;
  /** The root of its lineage, whose stream the feed is. */
  rootId: string;
  /** Every agent under `agentId`. */
  descendants: ReadonlySet<string>;
};

/**
 * Whose a feed row is, from the page's point of view: the page agent's own
 * (its turns, its posts, posts addressed to it, and on the root's page the
 * stream's own marks), a descendant's (a child's turn, a child's post, a
 * launch addressed to a child), or another agent's altogether.
 */
export function entryOwner(
  entry: StreamEntry,
  view: StreamView
): "own" | "child" | "other" {
  const { agentId, rootId, descendants } = view;
  const isRoot = agentId === rootId;
  if (entry.type === "turn") {
    if (entry.agentId === agentId) return "own";
    return descendants.has(entry.agentId) ? "child" : "other";
  }
  if (entry.type === "block") {
    const { author, toAgentId } = entry.block;
    if (author.kind === "agent") {
      if (author.agentId === agentId) return "own";
      if (descendants.has(author.agentId)) return "child";
    }
    if (toAgentId === agentId) return "own";
    if (toAgentId !== null && descendants.has(toAgentId)) return "child";
    return isRoot ? "own" : "other";
  }
  // Status marks are the stream's, so the root's.
  return isRoot ? "own" : "other";
}

/** The rows a page shows: its own, plus its descendants' when asked. */
export function filterStreamView(
  entries: readonly StreamEntry[],
  view: StreamView,
  showChildAgents: boolean
): StreamEntry[] {
  return entries.filter((entry) => {
    const owner = entryOwner(entry, view);
    return owner === "own" || (owner === "child" && showChildAgents);
  });
}

/**
 * What the main column shows of the feed. A reply (a block under a thread)
 * lives in the thread panel only, except an agent's post to another agent,
 * which is the one record of that exchange in the column (a parent's post
 * to a child threads under the child's launch post, and folds into the
 * parent's turn as "Sent to"). Dispatch's own marks stay — setup phases
 * (folded into the Setup block) and lifecycle seams (stopped, resumed) —
 * while the per-turn derived status is what the presence line already
 * shows.
 */
export function isMainColumnEntry(entry: StreamEntry): boolean {
  if (entry.type === "block") {
    const { block } = entry;
    if (block.threadId === null) return true;
    return block.author.kind === "agent" && block.toAgentId !== null;
  }
  if (entry.type === "status") {
    return entry.system === true && entry.phase !== "turn";
  }
  return true;
}

/** The thread and finding named in the URL (`?thread=<id>&finding=<id>`). */
export { FINDING_PARAM, THREAD_PARAM };

/** How close to the bottom (px) still counts as "following" the feed. */
const FOLLOW_THRESHOLD_PX = 48;
/** Scrolled up past this much of the view, the jump-to-bottom button shows. */
const JUMP_BUTTON_PX = 160;

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

/**
 * The page agent's turn whose message just landed: settled, with text,
 * not noticed before. Every settled turn present at the first pass is
 * remembered without being reported, so history never counts as landing.
 */
export function landedTurn(
  entries: readonly StreamEntry[],
  agentId: string,
  seen: Set<string>
): ChatTurnEntry | null {
  const first = seen.size === 0;
  let landed: ChatTurnEntry | null = null;
  for (const entry of entries) {
    if (entry.type !== "turn" || !entry.settled) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (first || entry.agentId !== agentId || !entry.result?.text) continue;
    landed = entry;
  }
  return landed;
}

/** Room left above the reply's header when the reader is put at its start. */
const REPLY_START_GAP_PX = 8;

/** Scroll so the reply's header sits at the top of the view, as far as the content allows. */
export function alignReplyStart(el: HTMLElement, turnId: string): void {
  const post = el.querySelector<HTMLElement>(
    `[data-turn-id="${turnId}"] [data-testid="chat-turn-result"]`
  );
  if (!post) return;
  const postTop =
    post.getBoundingClientRect().top -
    el.getBoundingClientRect().top +
    el.scrollTop;
  el.scrollTop = Math.max(0, postTop - REPLY_START_GAP_PX);
}

/**
 * Where to scroll so a reply that would not fit under the fold starts at
 * the top of the view, or null when pinning the bottom keeps its start in
 * sight. The reply's body may still be easing open, so its final height is
 * read from the content inside the wrapper, not the wrapper.
 */
export function replyStartIfTall(
  el: HTMLElement,
  turnId: string
): number | null {
  const post = el.querySelector<HTMLElement>(
    `[data-turn-id="${turnId}"] [data-testid="chat-turn-result"]`
  );
  if (!post) return null;
  const body = post.querySelector<HTMLElement>(
    '[data-testid="chat-turn-body"]'
  );
  const inner = body?.firstElementChild;
  const postRect = post.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const finalPostHeight =
    body && inner
      ? postRect.height -
        body.getBoundingClientRect().height +
        inner.getBoundingClientRect().height
      : postRect.height;
  const postTop = postRect.top - elRect.top + el.scrollTop;
  const finalScrollHeight = el.scrollHeight - postRect.height + finalPostHeight;
  const bottomPinnedTop = finalScrollHeight - el.clientHeight;
  if (postTop - REPLY_START_GAP_PX >= bottomPinnedTop) return null;
  return Math.max(0, postTop - REPLY_START_GAP_PX);
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
  active,
  showChildAgents,
  onShowChildAgentsChange,
  openLightbox,
  onOpenPath,
  isMobile,
}: ChatPaneProps): JSX.Element {
  // The stream is the root's: a child agent's page reads its root's feed
  // and filters it down to the child (see `entryOwner`).
  const rootId = useRootAgentId(agentId);
  const descendants = useDescendantAgentIds(agentId);
  const feed = useStreamFeed(rootId);
  const send = usePostBlock(rootId);
  const answer = useAnswerQuestion(rootId);
  const submitForm = useSubmitForm(rootId);
  const setBlockState = useSetBlockState(rootId);
  const reaction = useToggleReaction(rootId);
  const markRead = useMarkStreamRead(rootId, feed.unreadCount);
  // A post from a child's page goes to the child; the root's page posts to
  // the root, which is the stream's default recipient.
  const postTo = agentId && rootId && agentId !== rootId ? agentId : undefined;

  // The open thread lives in the URL so it survives a reload and a link
  // to a finding lands on it.
  const [searchParams, setSearchParams] = useSearchParams();
  const openThreadId = searchParams.get(THREAD_PARAM);
  const openFindingId = searchParams.get(FINDING_PARAM);
  const onOpenThread = useCallback(
    (blockId: string, findingId?: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(THREAD_PARAM, blockId);
          if (findingId) next.set(FINDING_PARAM, findingId);
          else next.delete(FINDING_PARAM);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );
  const onCloseThread = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(THREAD_PARAM);
        next.delete(FINDING_PARAM);
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);

  const entries = feed.entries;
  const view = useMemo<StreamView | null>(
    () => (agentId && rootId ? { agentId, rootId, descendants } : null),
    [agentId, descendants, rootId]
  );
  const visibleEntries = useMemo(
    () =>
      (view
        ? filterStreamView(entries, view, showChildAgents)
        : entries
      ).filter(isMainColumnEntry),
    [entries, showChildAgents, view]
  );
  // The page agent's own rows: what its composer answers, what its Stop
  // button stops, whose plan sits above the composer.
  const ownEntries = useMemo(
    () =>
      view
        ? entries.filter((entry) => entryOwner(entry, view) === "own")
        : entries,
    [entries, view]
  );
  // Status events alone are not a conversation: real agents always have
  // some, so the empty state must key off the entries a person wrote.
  const hasConversation = useMemo(
    () => visibleEntries.some((entry) => entry.type !== "status"),
    [visibleEntries]
  );
  const hasHiddenChildActivity = useMemo(
    () =>
      view !== null &&
      !showChildAgents &&
      entries.some((entry) => entryOwner(entry, view) === "child"),
    [entries, showChildAgents, view]
  );

  // A typed reply answers the newest open free-text question unless the
  // user has opted out of that question with the chip's ×.
  const openQuestion = useMemo(
    () => latestOpenFreeformQuestion(ownEntries),
    [ownEntries]
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
  /** Scrolled up far enough that a way back to the bottom is worth showing. */
  const [farFromBottom, setFarFromBottom] = useState(false);
  const lastEntryIdRef = useRef<string | null>(null);
  /** Id plus version of the tail entry: a streaming row grows in place. */
  const lastEntryKeyRef = useRef<string | null>(null);
  const seenEntryIdsRef = useRef<ReadonlySet<string>>(new Set());
  /** Turns whose message has already landed, so a settle is noticed once. */
  const settledTurnIdsRef = useRef<Set<string>>(new Set());
  /**
   * When the reader was last put at the start of a tall reply, or 0. The
   * content observer must not drag them back to the bottom while that
   * reply's body is still easing open, and the scroll handler must not
   * re-arm following off the jump itself: at that instant the body is
   * still short, so the reply's start reads as "near the bottom". Reaching
   * the bottom later, once the settle has played out, clears it.
   */
  const anchoredRef = useRef(0);
  /** The turn whose reply start the reader is held at, while anchored. */
  const anchorTurnRef = useRef<string | null>(null);
  const ANCHOR_HOLD_MS = 1200;
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

  // While following, the bottom stays in view through every change in the
  // content's height, not only the ones the layout effect below can name: a
  // turn's body easing open over a few frames, a streamed line landing, an
  // image sizing itself. The content is what is watched, not the scroller,
  // whose size only changes with the window.
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(following);
  followingRef.current = following;
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (anchoredRef.current !== 0) {
        // The reader was put at the start of a tall reply whose body is
        // still easing open: the scroller could not reach that start while
        // the content was short, so align again as it grows, then let go.
        if (
          anchorTurnRef.current &&
          Date.now() - anchoredRef.current < ANCHOR_HOLD_MS
        ) {
          const scroller = scrollRef.current;
          if (scroller) alignReplyStart(scroller, anchorTurnRef.current);
        }
        return;
      }
      if (followingRef.current) scrollToBottom();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollToBottom]);

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
    setFarFromBottom(distance > JUMP_BUTTON_PX);
    if (atBottom && Date.now() - anchoredRef.current < ANCHOR_HOLD_MS) {
      rememberSoon();
      return;
    }
    if (atBottom) anchoredRef.current = 0;
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
    const last = visibleEntries[visibleEntries.length - 1];
    const lastId = last?.id ?? null;
    // A turn is anchored where it started and never moves, so a link or a
    // review block written mid-turn lands below it and becomes the tail.
    // Reading growth off the tail alone would then stop following the turn
    // itself, which is the thing still getting taller.
    const liveTurn = newestTurnEntry(visibleEntries);
    const growth = [
      last ? entryGrowthKey(last) : null,
      liveTurn && !liveTurn.settled ? entryGrowthKey(liveTurn) : null,
    ].filter((key): key is string => key !== null);
    const lastKey = growth.length > 0 ? growth.join("|") : null;
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
      lastEntryKeyRef.current = lastKey;
      setPendingBelow(false);
      return;
    }
    const appended = lastId !== lastEntryIdRef.current || arrived.length > 0;
    // A streaming turn keeps its id while it grows; that is still new
    // content below the fold for a reader who is following.
    const grew = !appended && lastKey !== lastEntryKeyRef.current;
    lastEntryIdRef.current = lastId;
    lastEntryKeyRef.current = lastKey;
    if (!appended && !grew) return;
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
    // A turn's message landing. A long one would push its own start off the
    // top if the bottom stayed pinned, so the reader lands at the start of
    // the reply instead and reads down; following resumes when they reach
    // the bottom. A reply that fits under the fold pins the bottom as usual.
    const landed = agentId
      ? landedTurn(visibleEntries, agentId, settledTurnIdsRef.current)
      : null;
    if (following && landed) {
      if (replyStartIfTall(el, landed.id) !== null) {
        anchoredRef.current = Date.now();
        anchorTurnRef.current = landed.id;
        setFollowing(false);
        // A jump, not a smooth scroll: the first scroll events of a smooth
        // one still read as "at the bottom" and would re-arm following.
        alignReplyStart(el, landed.id);
        return;
      }
    }
    if (following) {
      scrollToBottom();
    } else if (appended) {
      setPendingBelow(true);
    }
  }, [agentId, following, scrollToBottom, showChildAgents, visibleEntries]);

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
    lastEntryKeyRef.current = null;
    seenEntryIdsRef.current = new Set();
    settledTurnIdsRef.current = new Set();
    anchoredRef.current = 0;
    olderLoadRef.current = null;
  }, [agentId]);

  useEffect(() => {
    if (active && following) scrollToBottom();
  }, [active, following, scrollToBottom]);

  // ---- unread: mark read while visible and focused --------------------------
  // markRead itself is a no-op while nothing is unread.
  const upTo = latestAgentBlockId(entries);
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
          blockId: replyTarget.id,
          value: text,
          attachments,
        });
        return;
      }
      await sendAsync({
        text,
        attachments,
        ...(postTo ? { to: postTo } : {}),
      });
    },
    [answerAsync, postTo, replyTarget, sendAsync]
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
    (blockId: string, option: BlockOption) => {
      setSendError(null);
      setFollowing(true);
      answerNow(
        {
          blockId,
          value: option.value ?? option.label,
          label: option.label,
        },
        { onError: (err) => setSendError(err.message) }
      );
    },
    [answerNow]
  );

  const { mutate: submitFormNow } = submitForm;
  const onSubmitForm = useCallback(
    (blockId: string, values: Record<string, string | number | boolean>) => {
      setSendError(null);
      setFollowing(true);
      submitFormNow(
        { blockId, values },
        { onError: (err) => setSendError(err.message) }
      );
    },
    [submitFormNow]
  );

  const { mutate: setBlockStateNow } = setBlockState;
  const onSetBlockState = useCallback(
    (blockId: string, patch: BlockStatePatch) => {
      setSendError(null);
      setBlockStateNow(
        { blockId, state: patch },
        { onError: (err) => setSendError(err.message) }
      );
    },
    [setBlockStateNow]
  );

  const { mutate: toggleReactionNow } = reaction;
  const onToggleReaction = useCallback(
    (blockId: string, emoji: string, remove: boolean) => {
      setSendError(null);
      // The pane's one error line is shared with sends, so say what failed.
      toggleReactionNow(
        { blockId, emoji, remove },
        {
          onError: (err) =>
            setSendError(
              `Couldn't ${remove ? "remove" : "add"} your ${emoji} reaction: ${err.message}`
            ),
        }
      );
    },
    [toggleReactionNow]
  );

  const { ctx } = useChatFeedContext({
    agentId,
    agent,
    openLightbox,
    onOpenPath,
    onToggleReaction,
    onOpenThread,
    onSubmitForm,
    onSetBlockState,
  });

  const disabledReason = composerDisabledReason(agent, {
    isLoading: feed.isLoading,
    error: feed.error,
  });
  const answeringBlockId = answer.isPending
    ? (answer.variables?.blockId ?? null)
    : null;
  const submittingBlockId = submitForm.isPending
    ? (submitForm.variables?.blockId ?? null)
    : null;

  const newestTurn = useMemo(() => newestTurnEntry(ownEntries), [ownEntries]);
  const turnRunning = newestTurn !== null && !newestTurn.settled;
  const tasks = useMemo(() => latestTurnPlan(ownEntries), [ownEntries]);
  const tasksOpen = tasks.some((t) => t.status !== "completed");
  const [tasksExpanded, setTasksExpanded] = useState(!isMobile);

  return (
    <MotionConfig reducedMotion="user">
      <div
        className="relative flex h-full min-h-0 min-w-0 max-w-full overflow-hidden bg-background"
        data-testid="chat-pane"
      >
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
              <div ref={contentRef} className="min-w-0 max-w-full">
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
                    {hasHiddenChildActivity ? (
                      <>
                        <div className="text-foreground">
                          Child-agent activity is hidden.
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
                          No messages yet. Send the first one below and the
                          agent replies here.
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
                    answeringBlockId={answeringBlockId}
                    submittingBlockId={submittingBlockId}
                    answersDisabled={disabledReason !== null}
                    onAnswer={onAnswer}
                  />
                ) : null}
              </div>
            </div>
            {!following && (farFromBottom || pendingBelow) ? (
              <div className="pointer-events-none absolute bottom-3 right-3">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={
                    pendingBelow
                      ? "New messages, jump to bottom"
                      : "Jump to bottom"
                  }
                  title={pendingBelow ? "New messages" : "Jump to bottom"}
                  data-testid="chat-jump-to-bottom"
                  data-pending={pendingBelow ? "true" : undefined}
                  className="pointer-events-auto relative h-9 w-9 rounded-full border-border/60 bg-background/70 text-foreground shadow-md backdrop-blur hover:bg-background/90"
                  onClick={() => {
                    anchoredRef.current = 0;
                    setFollowing(true);
                    setPendingBelow(false);
                    scrollToBottom("smooth");
                  }}
                >
                  <ArrowDown className="h-4 w-4" />
                  {pendingBelow ? (
                    <span
                      aria-hidden="true"
                      className="absolute right-1 top-1 h-2 w-2 rounded-full bg-status-working ring-2 ring-background"
                    />
                  ) : null}
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
            {sendError ? (
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  role="alert"
                  className="truncate text-[11px] text-destructive"
                >
                  {sendError}
                </span>
              </div>
            ) : null}
            {tasksOpen ? (
              <TasksStrip
                items={tasks}
                open={tasksExpanded}
                onOpenChange={setTasksExpanded}
              />
            ) : null}
            <ChatComposer
              agentId={agentId}
              onSend={onSend}
              uploadFile={uploadFile}
              disabledReason={disabledReason}
              sending={send.isPending || answer.isPending}
              autoFocus={active && !isMobile && !openThreadId}
              replyContext={replyContext}
              action={
                agentId && turnRunning ? (
                  <StopTurnButton agentId={agentId} onError={setSendError} />
                ) : undefined
              }
            />
          </div>
        </div>
        {agentId && rootId && openThreadId ? (
          <ThreadPanel
            key={openThreadId}
            agentId={agentId}
            rootId={rootId}
            blockId={openThreadId}
            findingId={openFindingId}
            ctx={ctx}
            disabledReason={disabledReason}
            isMobile={isMobile}
            onClose={onCloseThread}
            onAnswer={onAnswer}
            answeringBlockId={answeringBlockId}
            submittingBlockId={submittingBlockId}
          />
        ) : null}
      </div>
    </MotionConfig>
  );
}
