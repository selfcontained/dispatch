/**
 * Renders only the rows of a long list that are near the view, with spacers
 * standing in for the rest, so a stream hundreds of rows long mounts a few
 * dozen of them.
 *
 * Why: every mounted row costs DOM, layout and — in WebKit, which keeps a
 * tall scrolled list composited — graphics memory. A 600-row review stream
 * scrolled once held ~600 MB of Safari's graphics memory; only rows that are
 * not in the document stop costing it.
 *
 * The list keeps the scroller's own geometry: a spacer is the sum of its
 * rows' heights, measured once they have rendered (and remembered across
 * mounts of the same list) and estimated until then. So scrollHeight and
 * scrollTop keep meaning what the panes' follow-the-bottom and load-older
 * code expects.
 *
 * A row measured for the first time rarely matches its estimate. WebKit has
 * no scroll anchoring, so without help every such row would shift what the
 * reader is looking at. This keeps its own anchor instead: the first row in
 * view and its offset, put back after every commit and every size change,
 * unless the scroller moved on purpose since it was taken. While the view
 * follows the bottom, the bottom is kept instead.
 *
 * Rows named in `pinned` (a jump target, a row being restored to) and the
 * row that holds keyboard focus are always rendered, wherever they are, so
 * the code that scrolls to a row finds it and focus is never dropped by a
 * scroll.
 */
import {
  type FocusEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** Rendered beyond each edge of the view, in px. */
const OVERSCAN_PX = 1200;
/** Rows rendered before the list has been laid out once. */
const INITIAL_ROWS = 30;
/** A row's height until it has been measured, before any row has been. */
const DEFAULT_ESTIMATE_PX = 120;
/** Distance from the bottom that still counts as at the bottom. */
const AT_END_PX = 2;

/** Heights by row key, kept per list across mounts; the newest lists win. */
const HEIGHT_CACHE_LIMIT = 20;
const heightCaches = new Map<string, Map<string, number>>();

function heightCacheFor(
  cacheKey: string | null | undefined
): Map<string, number> {
  if (!cacheKey) return new Map();
  let cache = heightCaches.get(cacheKey);
  if (cache) {
    heightCaches.delete(cacheKey);
  } else {
    cache = new Map();
  }
  heightCaches.set(cacheKey, cache);
  if (heightCaches.size > HEIGHT_CACHE_LIMIT) {
    const oldest = heightCaches.keys().next();
    if (!oldest.done) heightCaches.delete(oldest.value);
  }
  return cache;
}

/** Tests share the module; let them start clean. */
export function clearWindowedRowHeights(): void {
  heightCaches.clear();
}

/**
 * How far the content under an anchor has moved since the anchor was
 * taken, net of scrolling: where the row sits in the content now (its
 * offset in the view plus scrollTop) against where it sat then.
 */
export function placeDrift(
  anchor: { offset: number; scrollTop: number },
  offset: number,
  scrollTop: number
): number {
  return offset + scrollTop - (anchor.offset + anchor.scrollTop);
}

export type WindowSegment =
  | { kind: "rows"; from: number; to: number }
  | { kind: "gap"; key: string; height: number };

type Range = { from: number; to: number };
/** A range as set, with the row it started at, to find it again when rows land above. */
type KeyedRange = Range & { first: string | null };
type Anchor = { key: string; offset: number; scrollTop: number };
/** How many rows in view are kept as anchors, first choice first. */
const ANCHOR_COUNT = 4;

export type WindowedRowsOptions = {
  /** The element that scrolls; the list sits somewhere inside it. */
  scrollRef: RefObject<HTMLElement>;
  /** Every row's key, in order. */
  keys: readonly string[];
  /** Where the list opens before it knows where the view is. */
  align: "start" | "end";
  /** Rows kept rendered wherever the view is. */
  pinned?: ReadonlySet<string>;
  /** While true, the bottom stays in view through size changes. */
  isFollowing?: () => boolean;
  /** Names the list so measured heights survive a remount. */
  cacheKey?: string | null;
  /** False renders every row, as a short list or a test would. */
  enabled?: boolean;
  /**
   * Rows that may hold the reader's place. A row whose key can move to
   * another position (a day rule, which sits above whichever row is first
   * that day) must not: the place would follow it.
   */
  anchorable?: (key: string) => boolean;
};

export type WindowedRows = {
  /** Goes on the element that directly holds the rows and spacers. */
  containerRef: RefObject<HTMLDivElement>;
  /**
   * Take the reader's place afresh, for a change about to land that the
   * list cannot see coming (a page of older rows is on its way).
   */
  holdPlace: () => void;
  /**
   * Take the reader's place from the rows in view now, straight after the
   * pane moved the scroller itself (a jump, a restore), before any row
   * around the new place has measured itself.
   */
  takePlace: () => void;
  /** Spread on that element too: the row holding focus stays rendered. */
  containerProps: {
    onFocus: (event: FocusEvent<HTMLElement>) => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
  };
  segments: WindowSegment[];
  /** Callback ref for the element wrapping row `key`. */
  measure: (key: string) => (el: HTMLElement | null) => void;
};

/** Whether lists window at all here (not without ResizeObserver, as in jsdom). */
export function windowingSupported(): boolean {
  return typeof ResizeObserver !== "undefined";
}

function initialRange(
  count: number,
  align: "start" | "end",
  windowing: boolean
): Range {
  if (!windowing) return { from: 0, to: count };
  return align === "end"
    ? { from: Math.max(0, count - INITIAL_ROWS), to: count }
    : { from: 0, to: Math.min(count, INITIAL_ROWS) };
}

export function useWindowedRows({
  scrollRef,
  keys,
  align,
  pinned,
  isFollowing,
  cacheKey,
  enabled = true,
  anchorable,
}: WindowedRowsOptions): WindowedRows {
  const containerRef = useRef<HTMLDivElement>(null);
  const [heights] = useState(() => heightCacheFor(cacheKey));
  // Keep unmeasured rows at one estimate for this mount. Recomputing the
  // average after every measurement resizes every spacer at once, making
  // a long stream's scrollbar move while the feed itself is idle.
  const [estimatedHeight] = useState(() => {
    if (heights.size === 0) return DEFAULT_ESTIMATE_PX;
    let sum = 0;
    for (const height of heights.values()) sum += height;
    return sum / heights.size;
  });
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const isFollowingRef = useRef(isFollowing);
  isFollowingRef.current = isFollowing;
  const anchorableRef = useRef(anchorable);
  anchorableRef.current = anchorable;

  // Without ResizeObserver there is no measuring and no layout to speak of
  // (jsdom): everything renders.
  const windowing = enabled && windowingSupported();
  const [range, setRange] = useState<KeyedRange>(() => ({
    ...initialRange(keys.length, align, windowing),
    first: null,
  }));
  /** The range as last rendered, by index into the current keys. */
  const rangeRef = useRef<Range>(range);
  const laidOutRef = useRef(false);
  const rangeStateRef = useRef(range);
  rangeStateRef.current = range;

  const [focusKey, setFocusKey] = useState<string | null>(null);

  /**
   * Positions are worked out with the same estimate the spacers use, or the
   * range would not match the rows the layout has in view.
   */
  /** Each row's top edge within the list, and the list's height at the end. */
  const tops = useCallback((): Float64Array => {
    const list = keysRef.current;
    const out = new Float64Array(list.length + 1);
    for (let i = 0; i < list.length; i += 1) {
      out[i + 1] = out[i]! + (heights.get(list[i]!) ?? estimatedHeight);
    }
    return out;
  }, [estimatedHeight, heights]);

  /**
   * The rows to render for where the view is now, or null to keep the ones
   * rendered (no layout yet, or hidden). The rendered rows are kept while
   * they still cover the view with half the overscan to spare and do not
   * run far past it: rows that change height as they mount would otherwise
   * move the edges on every pass and the range with them.
   */
  const computeRange = useCallback((): Range | null => {
    const scroller = scrollRef.current;
    const container = containerRef.current;
    const count = keysRef.current.length;
    if (!windowing) return { from: 0, to: count };
    if (!scroller || !container || scroller.clientHeight === 0) return null;
    const listTop =
      container.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    const top = scroller.scrollTop - listTop;
    const bottom = top + scroller.clientHeight;
    const edges = tops();
    const current = rangeRef.current;
    if (laidOutRef.current && current.to <= count) {
      const coveredTop = edges[current.from]!;
      const coveredBottom = edges[current.to]!;
      const covers =
        (current.from === 0 || coveredTop <= top - OVERSCAN_PX / 2) &&
        (current.to === count || coveredBottom >= bottom + OVERSCAN_PX / 2);
      const bounded =
        coveredBottom - coveredTop <= bottom - top + OVERSCAN_PX * 4;
      if (covers && bounded) return current;
    }
    let from = 0;
    while (from < count && edges[from + 1]! <= top - OVERSCAN_PX) from += 1;
    let to = from;
    while (to < count && edges[to]! < bottom + OVERSCAN_PX) to += 1;
    return { from, to: Math.max(to, Math.min(count, from + 1)) };
  }, [scrollRef, tops, windowing]);

  const updateRange = useCallback(() => {
    const next = computeRange();
    if (!next) return;
    laidOutRef.current = true;
    const current = rangeRef.current;
    const first = keysRef.current[next.from] ?? null;
    if (
      next.from !== current.from ||
      next.to !== current.to ||
      first !== rangeStateRef.current.first
    ) {
      setRange({ ...next, first });
    }
  }, [computeRange]);

  // ---- the anchor -----------------------------------------------------------
  const elements = useRef(new Map<string, HTMLElement>());
  /** Rows in view to hold the place by, first choice first. */
  const anchorsRef = useRef<Anchor[]>([]);

  /**
   * The rows to hold the reader's place by: the row the view starts inside,
   * then the rows whose top edge is in view (or, before older rows land
   * above, the lowest rows in view first). More than one, because a row can
   * leave the list between two commits (a post folded into a turn that
   * arrived with an older page).
   */
  const captureAnchor = useCallback(
    (from: "top" | "bottom" = "top") => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const viewTop = scroller.getBoundingClientRect().top;
      const viewBottom = viewTop + scroller.clientHeight;
      const inView: Array<Anchor & { top: number; bottom: number }> = [];
      let straddling: Anchor | null = null;
      for (const [key, el] of elements.current) {
        if (!el.isConnected || anchorableRef.current?.(key) === false) continue;
        const rect = el.getBoundingClientRect();
        if (
          rect.bottom <= viewTop ||
          rect.top >= viewBottom ||
          rect.height === 0
        ) {
          continue;
        }
        const anchor = {
          key,
          offset: rect.top - viewTop,
          scrollTop: scroller.scrollTop,
        };
        // A pixel of slack: a row the last correction put a fraction above
        // the edge is still the one being read.
        if (rect.top >= viewTop - 1) {
          inView.push({ ...anchor, top: rect.top, bottom: rect.bottom });
        } else {
          straddling = anchor;
        }
      }
      if (from === "top") {
        inView.sort((a, b) => a.top - b.top);
      } else {
        // Rows wholly in view, lowest first: furthest from rows about to
        // land above, and from the first row, which can change when they
        // do (its header folds into the post above it).
        inView.sort((a, b) => {
          const aWhole = a.bottom <= viewBottom ? 0 : 1;
          const bWhole = b.bottom <= viewBottom ? 0 : 1;
          return aWhole - bWhole || b.top - a.top;
        });
      }
      const anchors: Anchor[] = inView
        .slice(0, ANCHOR_COUNT)
        .map(({ key, offset, scrollTop }) => ({ key, offset, scrollTop }));
      // Reading from the top, the row the view starts inside comes first,
      // as the browser's own scroll anchoring would have it: when it grows
      // (its steps opened), what is under it moves down and the part being
      // read stays. Holding a row below it instead would push the row just
      // clicked up out of view.
      if (straddling) {
        if (from === "top") anchors.unshift(straddling);
        else anchors.push(straddling);
      }
      anchorsRef.current = anchors;
    },
    [scrollRef]
  );

  /** Where this code last put the scroller, so its own scroll event is not taken for the reader's. */
  const ownScrollRef = useRef<number | null>(null);

  /**
   * The anchors as they stand now, same rows in the same order: after a
   * correction the place is still held by the row it was held by, even if
   * another row has since come into view above it.
   */
  const refreshAnchors = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const viewTop = scroller.getBoundingClientRect().top;
    const kept: Anchor[] = [];
    for (const anchor of anchorsRef.current) {
      const el = elements.current.get(anchor.key);
      if (!el?.isConnected) continue;
      kept.push({
        key: anchor.key,
        offset: el.getBoundingClientRect().top - viewTop,
        scrollTop: scroller.scrollTop,
      });
    }
    if (kept.length > 0) anchorsRef.current = kept;
    else captureAnchor();
  }, [captureAnchor, scrollRef]);

  /**
   * Put the rows holding the place back where they sat in the content.
   * Anchors are compared where they sit in the content (offset plus
   * scrollTop), so a scroll not yet reported by its event is not taken
   * for a shift, nor a shift for a scroll. The scroller having moved by
   * more than a view since they were taken is a jump or a restore: that
   * stands, and nothing is corrected. False when nothing could be held.
   */
  const correct = useCallback((): boolean => {
    const scroller = scrollRef.current;
    const anchors = anchorsRef.current;
    if (
      !scroller ||
      anchors.length === 0 ||
      Math.abs(scroller.scrollTop - anchors[0]!.scrollTop) >
        scroller.clientHeight
    ) {
      return false;
    }
    const viewTop = scroller.getBoundingClientRect().top;
    for (const anchor of anchors) {
      const el = elements.current.get(anchor.key);
      if (!el?.isConnected) continue;
      const drift = placeDrift(
        anchor,
        el.getBoundingClientRect().top - viewTop,
        scroller.scrollTop
      );
      if (Math.abs(drift) >= 0.5) {
        scroller.scrollTop += drift;
        ownScrollRef.current = scroller.scrollTop;
      }
      return true;
    }
    return false;
  }, [scrollRef]);

  const keepPlace = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || !windowing) return;
    if (isFollowingRef.current?.()) {
      const bottom = scroller.scrollHeight - scroller.clientHeight;
      if (bottom - scroller.scrollTop > AT_END_PX) scroller.scrollTop = bottom;
      captureAnchor();
      return;
    }
    if (correct()) refreshAnchors();
    else captureAnchor();
  }, [captureAnchor, correct, refreshAnchors, scrollRef, windowing]);

  const takePlaceHere = useCallback(
    () => captureAnchor("top"),
    [captureAnchor]
  );
  const holdPlaceBelow = useCallback(
    () => captureAnchor("bottom"),
    [captureAnchor]
  );

  // ---- measuring rows ------------------------------------------------------
  const rowObserverRef = useRef<ResizeObserver | null>(null);
  const keepPlaceRef = useRef(keepPlace);
  keepPlaceRef.current = keepPlace;
  const updateRangeRef = useRef(updateRange);
  updateRangeRef.current = updateRange;
  const scheduleRangeRef = useRef<() => void>(() => {});

  // Made in an effect, not during render: a strict-mode remount runs the
  // cleanup and then this again, and the rows already on screen are
  // observed afresh.
  useEffect(() => {
    if (!windowing) return;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const key = el.dataset.windowKey;
        if (!key || !el.isConnected) continue;
        const height =
          entry.borderBoxSize?.[0]?.blockSize ??
          el.getBoundingClientRect().height;
        if (heights.get(key) !== height) {
          heights.set(key, height);
          changed = true;
        }
      }
      if (!changed) return;
      keepPlaceRef.current();
      scheduleRangeRef.current();
    });
    rowObserverRef.current = observer;
    for (const el of elements.current.values()) observer.observe(el);
    return () => {
      observer.disconnect();
      rowObserverRef.current = null;
    };
  }, [heights, windowing]);

  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const measure = useCallback((key: string) => {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = (el: HTMLElement | null) => {
        const previous = elements.current.get(key);
        if (previous && previous !== el) {
          rowObserverRef.current?.unobserve(previous);
          elements.current.delete(key);
        }
        if (!el) return;
        el.dataset.windowKey = key;
        elements.current.set(key, el);
        rowObserverRef.current?.observe(el);
      };
      refs.current.set(key, ref);
    }
    return ref;
  }, []);
  // Refs of rows that left the list for good.
  useEffect(() => {
    const present = new Set(keys);
    for (const key of refs.current.keys()) {
      if (!present.has(key)) refs.current.delete(key);
    }
  }, [keys]);

  // ---- following the view ---------------------------------------------------
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !windowing) return;
    const onScroll = () => {
      // The scroll this code made to hold the place is not the reader
      // moving: keep holding it by the same rows.
      const own = ownScrollRef.current;
      ownScrollRef.current = null;
      if (own !== null && Math.abs(scroller.scrollTop - own) < 1) {
        refreshAnchors();
      } else {
        // Anything that moved the rows since the last look (a row above
        // the view resized in the same frame) is put right before the new
        // place is taken, or it would be taken as the new place.
        if (!isFollowingRef.current?.()) correct();
        captureAnchor();
      }
      scheduleRangeRef.current();
    };
    const resize = new ResizeObserver(() => scheduleRangeRef.current());
    scroller.addEventListener("scroll", onScroll, { passive: true });
    resize.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      resize.disconnect();
    };
  }, [captureAnchor, correct, refreshAnchors, scrollRef, windowing]);

  // Keyboard focus keeps its row: React's focus events bubble, so the
  // container hears every row's.
  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-window-key]"
    );
    setFocusKey(row?.dataset.windowKey ?? null);
  }, []);
  const onBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.contains(next)) setFocusKey(null);
  }, []);

  // After every commit: hold the reader's place, and on the next frame see
  // whether the rows around the view changed (the list grew, a page landed
  // above). Not in this commit: rows just mounted have not been measured
  // yet, and ranges picked from estimates in a chain of synchronous commits
  // can chase each other.
  // A frame, or a short timer when frames are held back (WebKit throttles
  // them for a window it considers hidden or idle); whichever comes first.
  const frameRef = useRef<{ frame: number; timer: number } | null>(null);
  const scheduleRange = useCallback(() => {
    if (frameRef.current) return;
    const run = () => {
      const pending = frameRef.current;
      if (!pending) return;
      cancelAnimationFrame(pending.frame);
      window.clearTimeout(pending.timer);
      frameRef.current = null;
      updateRangeRef.current();
    };
    frameRef.current = {
      frame: requestAnimationFrame(run),
      timer: window.setTimeout(run, 60),
    };
  }, []);
  scheduleRangeRef.current = scheduleRange;
  useEffect(
    () => () => {
      const pending = frameRef.current;
      if (pending) {
        cancelAnimationFrame(pending.frame);
        window.clearTimeout(pending.timer);
      }
      frameRef.current = null;
    },
    []
  );
  useLayoutEffect(() => {
    keepPlace();
    if (windowing) scheduleRange();
  });

  // ---- what to render -------------------------------------------------------
  // The range is kept by index, but it means rows: when rows land above
  // (a page of older ones) the same rows are found at their new place.
  const shown = shownRange({
    windowing,
    laidOut: laidOutRef.current,
    range,
    keys,
    align,
  });
  rangeRef.current = shown;
  // The rows holding the reader's place stay too: dropping them would lose
  // the place with them.
  const anchorKeys = new Set(anchorsRef.current.map((anchor) => anchor.key));
  const segments = windowSegments(
    keys,
    shown,
    (key) =>
      pinned?.has(key) === true || key === focusKey || anchorKeys.has(key),
    (key) => heights.get(key) ?? estimatedHeight
  );

  return {
    containerRef,
    containerProps: { onFocus, onBlur },
    holdPlace: holdPlaceBelow,
    takePlace: takePlaceHere,
    segments,
    measure,
  };
}

/**
 * The rows to render this pass: all of them when not windowing; before the
 * first layout, the end (or start) the list opens at; otherwise the range
 * as set, found again by its first row when rows have landed above it.
 */
export function shownRange({
  windowing,
  laidOut,
  range,
  keys,
  align,
}: {
  windowing: boolean;
  laidOut: boolean;
  range: Range & { first: string | null };
  keys: readonly string[];
  align: "start" | "end";
}): Range {
  const count = keys.length;
  if (!windowing) return { from: 0, to: count };
  if (!laidOut) return initialRange(count, align, windowing);
  const shown = {
    from: Math.min(range.from, count),
    to: Math.min(range.to, count),
  };
  if (range.first === null || keys[range.from] === range.first) return shown;
  const moved = keys.indexOf(range.first);
  if (moved === -1) return shown;
  const shift = moved - range.from;
  return {
    from: Math.min(count, range.from + shift),
    to: Math.min(count, range.to + shift),
  };
}

/**
 * Runs of rendered rows and the spacers between them: a row renders when it
 * is in `shown` or `always` says so; everything else is summed into gaps.
 */
export function windowSegments(
  keys: readonly string[],
  shown: Range,
  always: (key: string) => boolean,
  heightOf: (key: string) => number
): WindowSegment[] {
  const segments: WindowSegment[] = [];
  let gap: { key: string; height: number } | null = null;
  let run: { kind: "rows"; from: number; to: number } | null = null;
  keys.forEach((key, i) => {
    if ((i >= shown.from && i < shown.to) || always(key)) {
      if (gap) {
        segments.push({
          kind: "gap",
          key: `gap:${gap.key}`,
          height: gap.height,
        });
        gap = null;
      }
      if (run) {
        run.to = i + 1;
      } else {
        run = { kind: "rows", from: i, to: i + 1 };
        segments.push(run);
      }
      return;
    }
    run = null;
    if (gap) gap.height += heightOf(key);
    else gap = { key, height: heightOf(key) };
  });
  if (gap) {
    const last: { key: string; height: number } = gap;
    segments.push({ kind: "gap", key: `gap:${last.key}`, height: last.height });
  }
  return segments;
}

/** A spacer standing in for rows that are not rendered. */
export function WindowGap({ height }: { height: number }): JSX.Element {
  return <div aria-hidden="true" data-testid="window-gap" style={{ height }} />;
}

/** The wrapper every windowed row renders in, measured by `measure`. */
export function WindowRow({
  rowKey,
  measure,
  children,
}: {
  rowKey: string;
  measure: (key: string) => (el: HTMLElement | null) => void;
  children: ReactNode;
}): JSX.Element {
  return <div ref={measure(rowKey)}>{children}</div>;
}
