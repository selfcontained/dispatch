/**
 * The same windowing as `useWindowedRows`, built on @tanstack/react-virtual:
 * the library measures rows, picks the range and corrects the scroll for
 * rows above the view that change size. Rows still render in normal flow,
 * with spacers where the library says rows would be, so the panes' own
 * scroll code keeps working. Prototype for comparison (VITE_WINDOWING).
 */
import {
  type Range,
  defaultRangeExtractor,
  useVirtualizer,
} from "@tanstack/react-virtual";
import {
  type FocusEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type WindowedRows,
  type WindowedRowsOptions,
  type WindowSegment,
  windowingSupported,
} from "./windowed-rows";

const OVERSCAN_ROWS = 8;
const ESTIMATE_PX = 120;

export function useWindowedRowsTanstack({
  scrollRef,
  keys,
  pinned,
  enabled = true,
  anchorable,
}: WindowedRowsOptions): WindowedRows {
  const anchorableRef = useRef(anchorable);
  anchorableRef.current = anchorable;
  const containerRef = useRef<HTMLDivElement>(null);
  const windowing = enabled && windowingSupported();
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const keysRef = useRef(keys);
  keysRef.current = keys;
  const heldRef = useRef<{ key: string; offset: number; index: number } | null>(
    null
  );

  const always = useMemo(() => {
    const set = new Set<number>();
    keys.forEach((key, i) => {
      if (pinned?.has(key) || key === focusKey) set.add(i);
    });
    return set;
  }, [focusKey, keys, pinned]);

  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = new Set(defaultRangeExtractor(range));
      for (const i of always) indexes.add(i);
      // The row holding the place while older rows land stays too.
      const held = heldRef.current;
      if (held) {
        const i = keysRef.current.indexOf(held.key);
        if (i !== -1) indexes.add(i);
      }
      return [...indexes].sort((a, b) => a - b);
    },
    [always]
  );

  const virtualizer = useVirtualizer({
    count: windowing ? keys.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATE_PX,
    getItemKey: (index) => keysRef.current[index] ?? index,
    overscan: OVERSCAN_ROWS,
    scrollMargin,
    rangeExtractor,
    // Where the list opens is the pane's business (it scrolls to the
    // bottom, a saved place or a jump target); the library follows.
    initialOffset: () => scrollRef.current?.scrollTop ?? 0,
  });

  // Where the list starts inside the scroller's content.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const container = containerRef.current;
    if (!scroller || !container) return;
    const margin =
      container.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    if (Math.abs(margin - scrollMargin) >= 1) setScrollMargin(margin);
  }, [keys, scrollMargin, scrollRef]);

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

  // Rows landing above (a page of older ones) keep the view where it was:
  // the library places them, but only scrolls for rows it re-measures. The
  // pane takes the place (the lowest row in view) just before it asks for
  // them, and the commit that brings them puts that row back.
  const holdPlace = useCallback(() => {
    const scroller = scrollRef.current;
    const container = containerRef.current;
    if (!scroller || !container) return;
    const view = scroller.getBoundingClientRect();
    const rows = [
      ...container.querySelectorAll<HTMLElement>("[data-window-key]"),
    ]
      .filter((el) => anchorableRef.current?.(el.dataset.windowKey!) !== false)
      .reverse();
    const row =
      rows.find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top >= view.top && rect.bottom <= view.bottom;
      }) ?? rows.find((el) => el.getBoundingClientRect().top >= view.top);
    heldRef.current = row
      ? {
          key: row.dataset.windowKey!,
          offset: row.getBoundingClientRect().top - view.top,
          index: keysRef.current.indexOf(row.dataset.windowKey!),
        }
      : null;
  }, [scrollRef]);
  // Put the held row back where it was: once in the commit that brings the
  // older rows, and again while the rows around it measure themselves
  // (the first row of the old page loses its header to an older post by
  // the same author, for one), which the library does not correct for rows
  // in view.
  const HOLD_MS = 800;
  const restoreHeld = useCallback(() => {
    const held = heldRef.current;
    const scroller = scrollRef.current;
    if (!held || !scroller) return;
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-window-key="${CSS.escape(held.key)}"]`
    );
    if (!el) return;
    const drift =
      el.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      held.offset;
    if (Math.abs(drift) >= 0.5) scroller.scrollTop += drift;
  }, [scrollRef]);
  const heldUntilRef = useRef(0);
  useLayoutEffect(() => {
    const held = heldRef.current;
    // The older rows are in when the held row has moved down the list.
    const index = held ? keys.indexOf(held.key) : -1;
    if (held && index !== held.index) {
      held.index = index;
      heldUntilRef.current = Date.now() + HOLD_MS;
    }
    if (Date.now() < heldUntilRef.current) restoreHeld();
    else if (held && heldUntilRef.current !== 0) {
      heldRef.current = null;
      heldUntilRef.current = 0;
    }
  });
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (Date.now() < heldUntilRef.current) restoreHeld();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [restoreHeld]);

  // The library reads each row's index off the element; rows move when
  // older ones land above, so keep it current.
  const elements = useRef(new Map<string, HTMLElement>());
  useLayoutEffect(() => {
    const index = new Map(keys.map((key, i) => [key, i]));
    for (const [key, el] of elements.current) {
      const i = index.get(key);
      if (i === undefined || !el.isConnected) elements.current.delete(key);
      else el.dataset.index = String(i);
    }
  });

  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const measure = useCallback(
    (key: string) => {
      let ref = refs.current.get(key);
      if (!ref) {
        ref = (el: HTMLElement | null) => {
          if (!el) return;
          el.dataset.windowKey = key;
          el.dataset.index = String(keysRef.current.indexOf(key));
          elements.current.set(key, el);
          virtualizer.measureElement(el);
        };
        refs.current.set(key, ref);
      }
      return ref;
    },
    [virtualizer]
  );

  let segments: WindowSegment[];
  if (!windowing) {
    segments = keys.length ? [{ kind: "rows", from: 0, to: keys.length }] : [];
  } else {
    segments = [];
    const items = virtualizer.getVirtualItems();
    let at = scrollMargin;
    let run: { kind: "rows"; from: number; to: number } | null = null;
    for (const item of items) {
      const gap = item.start - at;
      if (gap > 0.5 || (run && item.index !== run.to)) {
        segments.push({
          kind: "gap",
          key: `gap:${keys[item.index]}`,
          height: Math.max(0, gap),
        });
        run = null;
      }
      if (run) run.to = item.index + 1;
      else {
        run = { kind: "rows", from: item.index, to: item.index + 1 };
        segments.push(run);
      }
      at = item.end;
    }
    const end = virtualizer.getTotalSize() + scrollMargin - at;
    if (end > 0.5) segments.push({ kind: "gap", key: "gap:end", height: end });
  }

  return {
    containerRef,
    containerProps: { onFocus, onBlur },
    holdPlace,
    segments,
    measure,
  };
}
