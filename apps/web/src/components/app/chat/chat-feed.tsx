import {
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { Block, BlockOption, StreamEntry } from "@dispatch/shared";

import {
  blockAuthor,
  BlockView,
  DayDivider,
  dayLabel,
  type FeedContext,
} from "@/components/app/chat/chat-entries";
import {
  type FoldedEntry,
  foldAttachments,
} from "@/components/app/chat/turn/turn-attachments";
import { isTurnEntry } from "@/components/app/chat/turn/trace";

import { ChatRowStateContext, type ChatRowState } from "./chat-row-state";
import { useWindowedRows, WindowGap } from "./windowed-rows";

/**
 * What the channel draws, top to bottom: day rules, and posts that know
 * whether they continue the post above them.
 */
export type ChatFeedRow =
  | { kind: "divider"; key: string; label: string }
  | {
      kind: "entry";
      entry: StreamEntry;
      grouped: boolean;
      /**
       * A hairline above this post: it starts a new author group right after
       * another post. Off when a day rule already sits between the two, so
       * nothing is separated twice.
       */
      rule: boolean;
      /**
       * A turn only: the files, links and posts to other agents the agent
       * produced while it ran, lifted out of the feed and into the turn's
       * post.
       */
      folded?: FoldedEntry[];
    };

/** Posts by one author this close together share a header, like Slack. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * What "the same entry, changed" means for the fade-in: a post edited in
 * place has a new one. A stream row growing chunk by chunk is not a new
 * version here, or every chunk would remount the post and collapse an
 * expanded activity row; growth is {@link entryGrowthKey}'s business.
 */
export function entryVersion(entry: StreamEntry): string {
  // Only an agent edits a post; a user's post changes just its delivery
  // and read marks, which are not a new version to fade in. A turn's block
  // is written when the turn settles; that landing is not an edit either.
  return entry.block.author.kind === "agent" && !entry.block.turn
    ? entry.block.updatedAt
    : entry.block.createdAt;
}

/** The row a stream entry renders in: the block's own id. */
export function rowIdentity(entry: StreamEntry, _ownerId?: string): string {
  return entry.id;
}

/**
 * The tail entry's identity plus everything that makes it taller: text as it
 * streams in, a tool call's status or output. The pane keys its follow
 * logic on this so new content below the fold still pins the scroll.
 */
export function entryGrowthKey(entry: StreamEntry): string {
  const base = `${entry.id}:${entryVersion(entry)}`;
  const turn = entry.block.turn;
  if (!turn) return base;
  // Everything that makes a turn taller: the newest row folded in, the
  // step list's length, the answer as it streams, and the settle that folds
  // the steps away. `entryVersion` stays the block's birth, so growth does not
  // re-fade the entry.
  return `${base}:${turn.updatedAt}:${turn.trace.steps.length}:${entry.block.text.length}:${turn.settled ? 1 : 0}`;
}

/**
 * The entries to fade in: those that arrived after the feed first rendered,
 * plus posts edited in place — never what was there at mount, and never a
 * page of older entries. An unseen id is an arrival when it is at least as
 * new as the newest entry seen so far, or when it sits below an entry that
 * was already here (a late block can land by time under the newest
 * post); a page from "Load older" is the one thing that only ever lands
 * above everything seen. The value is the version the animation belongs
 * to, so an edit of an entry that already faded in fades it in again.
 *
 * Bookkeeping lives in refs and is updated during render: it only ever
 * adds to the answer for the current entries, so a repeated render (strict
 * mode) settles on the same result.
 */
export function useEnteringEntries(
  entries: StreamEntry[],
  ownerId?: string
): ReadonlyMap<string, string> {
  const seenRef = useRef<Map<string, string> | null>(null);
  const newestAtRef = useRef("");
  const enteringRef = useRef(new Map<string, string>());

  if (seenRef.current === null) {
    seenRef.current = new Map(
      entries.map((entry) => [rowIdentity(entry, ownerId), entryVersion(entry)])
    );
    for (const entry of entries) {
      if (entry.at > newestAtRef.current) newestAtRef.current = entry.at;
    }
    return enteringRef.current;
  }

  const seen = seenRef.current;
  const entering = enteringRef.current;
  const present = new Set<string>();
  let newest = newestAtRef.current;
  let afterSeen = false;
  for (const entry of entries) {
    const id = rowIdentity(entry, ownerId);
    present.add(id);
    const version = entryVersion(entry);
    const prior = seen.get(id);
    if (prior === undefined) {
      // New here, and either newer than anything seen or sitting below a
      // row that was already here: a live arrival, wherever time put it.
      // Only a page of older rows lands above everything seen.
      if (entry.at >= newestAtRef.current || afterSeen) {
        entering.set(id, version);
      }
    } else {
      afterSeen = true;
      // A post edited in place fades in again.
      if (prior !== version) entering.set(id, version);
    }
    seen.set(id, version);
    if (entry.at > newest) newest = entry.at;
  }
  newestAtRef.current = newest;
  for (const id of [...seen.keys()]) {
    if (!present.has(id)) {
      seen.delete(id);
      entering.delete(id);
    }
  }
  return entering;
}

/**
 * Ids of entries that were not in `seen` and sit below one that was — live
 * arrivals, as opposed to a page of older rows, which lands above every
 * seen entry. Empty when nothing was seen yet (first render).
 */
export function arrivedEntryIds(
  seen: ReadonlySet<string>,
  entries: readonly StreamEntry[]
): string[] {
  const arrived: string[] = [];
  let afterSeen = false;
  for (const entry of entries) {
    if (seen.has(entry.id)) afterSeen = true;
    else if (afterSeen) arrived.push(entry.id);
  }
  return arrived;
}

/**
 * Fades a fresh entry in unless the viewer prefers reduced motion.
 * Keyed by the version so
 * an in-place edit runs it again; a settled entry renders bare.
 */
function Enter({
  id,
  entering,
  played,
  children,
}: {
  id: string;
  entering: ReadonlyMap<string, string>;
  /**
   * Arrivals whose fade already ran. A windowed feed unmounts rows that
   * scroll out of view; coming back into view is not arriving again.
   */
  played: Set<string>;
  children: ReactNode;
}): JSX.Element {
  const version = entering.get(id);
  const run = version === undefined ? null : `${id}\n${version}`;
  // Decided once per version on this mount, so a fade in progress keeps its
  // class through re-renders.
  const freshRef = useRef<{ run: string | null; fresh: boolean } | null>(null);
  if (freshRef.current === null || freshRef.current.run !== run) {
    freshRef.current = { run, fresh: run !== null && !played.has(run) };
  }
  const fresh = freshRef.current.fresh;
  useEffect(() => {
    if (run !== null) played.add(run);
  }, [played, run]);
  // Always a real element, animating or not: `data-chat-entry-id` is how
  // ChatPane names the row a reader was parked on so it can put them back
  // there when the feed reopens.
  return (
    <div
      key={version}
      data-chat-entry-id={id}
      className={
        fresh ? "animate-chat-enter motion-reduce:animate-none" : undefined
      }
      data-testid={fresh ? "chat-entry-enter" : undefined}
    >
      {children}
    </div>
  );
}

function authorKey(entry: StreamEntry, ctx: FeedContext): string {
  // A post to another agent groups by both ends, so a run between the
  // same two agents shares a header and the next post to people starts
  // a new one.
  const { key } = blockAuthor(entry.block, ctx);
  const to = entry.block.toAgentId;
  return entry.block.author.kind === "agent" && to !== null
    ? `${key}>${to}`
    : key;
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Lay the collapsed feed out as channel rows: a rule wherever the day
 * changes, and a post grouped under the previous one when the same author
 * posted it within {@link GROUP_WINDOW_MS} with nothing else in between.
 */
export function layoutFeed(
  entries: StreamEntry[],
  ctx: FeedContext,
  now: Date = new Date()
): ChatFeedRow[] {
  const rows: ChatFeedRow[] = [];
  let lastDay: string | null = null;
  let lastPost: { key: string; at: number } | null = null;
  const fold = foldAttachments(entries, ctx.agentId);
  for (const entry of fold.entries) {
    const item = { kind: "entry" as const, entry };
    const day = dayKey(item.entry.at);
    if (day !== lastDay) {
      rows.push({
        kind: "divider",
        key: `day:${day}`,
        label: dayLabel(item.entry.at, now),
      });
      lastDay = day;
      lastPost = null;
    }
    // A turn's answer is a post with a step list under it: it always starts a
    // fresh group, draws no hairline of its own, and ends the run behind
    // it so the post after it opens with a header.
    if (isTurnEntry(item.entry)) {
      const folded = fold.folded.get(item.entry.id);
      rows.push({
        kind: "entry",
        entry: item.entry,
        grouped: false,
        rule: false,
        ...(folded ? { folded } : {}),
      });
      lastPost = null;
      continue;
    }
    const key = authorKey(item.entry, ctx);
    const at = new Date(item.entry.at).getTime();
    const grouped =
      lastPost !== null &&
      lastPost.key === key &&
      Number.isFinite(at) &&
      at - lastPost.at <= GROUP_WINDOW_MS;
    const rule = !grouped && rows[rows.length - 1]?.kind === "entry";
    rows.push({ kind: "entry", entry: item.entry, grouped, rule });
    lastPost = { key, at: Number.isFinite(at) ? at : 0 };
  }
  return rows;
}

/** The id of the most recent user block, for the hold hint. */
export function latestUserBlockId(entries: StreamEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.block.author.kind === "user") return entry.block.id;
  }
  return null;
}

/**
 * The newest unanswered question that accepts a typed reply. While one is
 * open the composer answers it instead of sending a plain message.
 */
export function latestOpenFreeformQuestion(
  entries: StreamEntry[]
): Extract<Block, { kind: "question" }> | null {
  // A turn republishes whole on every flush, so its answer state can be
  // fresher than the question's own cached row.
  const answeredByTurn = new Set<string>();
  for (const entry of entries) {
    for (const ref of entry.block.turn?.questions ?? []) {
      if (ref.answered) answeredByTurn.add(ref.messageId);
    }
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    const block = entry.block;
    if (block.author.kind !== "agent" || block.kind !== "question") continue;
    if (block.toAgentId !== null) continue;
    const cancellation = (
      block.state as { cancellation?: unknown } | null | undefined
    )?.cancellation;
    if (
      block.state?.answer !== undefined ||
      cancellation !== undefined ||
      answeredByTurn.has(block.id)
    ) {
      continue;
    }
    return block.data.allowFreeform ? block : null;
  }
  return null;
}

/** The id of the most recent agent block for people, the `upTo` for mark-read. */
export function latestAgentBlockId(entries: StreamEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.block.author.kind === "agent" && entry.block.toAgentId === null) {
      return entry.block.id;
    }
  }
  return null;
}

/** What the pane can ask of a windowed feed around its own scrolling. */
export type FeedPlace = {
  /** Before older rows load above: hold the place by the rows in view. */
  holdBelow: () => void;
  /** After the pane scrolled (a jump, a restore): the rows in view now hold it. */
  takeHere: () => void;
};

export type ChatFeedProps = {
  entries: StreamEntry[];
  ctx: FeedContext;
  /** Question whose answer is in flight, if any. */
  answeringBlockId: string | null;
  /** Form whose submission is in flight, if any. */
  submittingBlockId?: string | null;
  /** Answers go through the same delivery as the composer; lock them together. */
  answersDisabled?: boolean;
  onAnswer: (blockId: string, option: BlockOption) => void;
  /**
   * The pane's scroller. Given, only the rows near the view render (see
   * useWindowedRows); without it every row does.
   */
  scrollRef?: RefObject<HTMLElement>;
  /** Rows that must be rendered wherever the view is: a jump target. */
  pinnedIds?: ReadonlySet<string>;
  /** True while the pane keeps its bottom in view. */
  isFollowing?: () => boolean;
  /** Filled with the feed's hold on the reader's place, for the pane's own scrolls. */
  placeRef?: MutableRefObject<FeedPlace | null>;
};

/** The key a feed row renders under: a day rule's, or its entry's. */
function feedRowKey(row: ChatFeedRow, ownerId?: string): string {
  return row.kind === "divider" ? row.key : rowIdentity(row.entry, ownerId);
}

/** Day rules move to whichever row is first that day; they hold no place. */
function isEntryRowKey(key: string): boolean {
  return !key.startsWith("day:");
}

export function ChatFeed({
  entries,
  ctx,
  answeringBlockId,
  submittingBlockId = null,
  answersDisabled = false,
  onAnswer,
  scrollRef,
  pinnedIds,
  isFollowing,
  placeRef,
}: ChatFeedProps): JSX.Element {
  const rows = useMemo(() => layoutFeed(entries, ctx), [entries, ctx]);
  const rowKeys = useMemo(
    () => rows.map((row) => feedRowKey(row, ctx.agentId)),
    [rows, ctx.agentId]
  );
  const fallbackRef = useRef<HTMLElement>(null);
  const windowed = useWindowedRows({
    scrollRef: scrollRef ?? fallbackRef,
    keys: rowKeys,
    align: "end",
    pinned: pinnedIds,
    isFollowing,
    cacheKey: ctx.agentId ? `feed:${ctx.agentId}` : null,
    enabled: scrollRef !== undefined,
    anchorable: isEntryRowKey,
  });
  if (placeRef) {
    placeRef.current = {
      holdBelow: windowed.holdPlace,
      takeHere: windowed.takePlace,
    };
  }
  const entering = useEnteringEntries(entries, ctx.agentId);
  const playedRef = useRef(new Set<string>());
  // Disclosure state per row (an expanded step, a folded step list), owned here so
  // it survives a row re-rendering; entries that left the feed drop theirs.
  const rowStates = useRef(new Map<string, ChatRowState>());
  const present = new Set(entries.map((entry) => entry.id));
  for (const id of rowStates.current.keys()) {
    if (!present.has(id)) rowStates.current.delete(id);
  }
  const rowState = (id: string): ChatRowState => {
    let state = rowStates.current.get(id);
    if (!state) {
      state = new Map();
      rowStates.current.set(id, state);
    }
    return state;
  };

  const renderRow = (row: ChatFeedRow): JSX.Element => {
    if (row.kind === "divider") {
      return <DayDivider label={row.label} />;
    }
    const entry = row.entry;
    return (
      <Enter
        id={rowIdentity(entry, ctx.agentId)}
        entering={entering}
        played={playedRef.current}
      >
        <ChatRowStateContext.Provider value={rowState(entry.id)}>
          <BlockView
            block={entry.block}
            grouped={row.grouped}
            rule={row.rule}
            ctx={ctx}
            answering={answeringBlockId === entry.block.id}
            submitting={submittingBlockId === entry.block.id}
            answersDisabled={answersDisabled}
            onAnswer={onAnswer}
            folded={row.folded}
          />
        </ChatRowStateContext.Provider>
      </Enter>
    );
  };

  return (
    <div
      ref={windowed.containerRef}
      {...windowed.containerProps}
      className="flex min-w-0 max-w-full flex-col overflow-x-hidden pb-1"
      data-testid="chat-feed"
    >
      {windowed.segments.flatMap((segment) =>
        segment.kind === "gap"
          ? [<WindowGap key={segment.key} height={segment.height} />]
          : rows.slice(segment.from, segment.to).map((row, offset) => {
              const key = rowKeys[segment.from + offset]!;
              return (
                <div key={key} ref={windowed.measure(key)}>
                  {renderRow(row)}
                </div>
              );
            })
      )}
    </div>
  );
}
