import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type VirtualItem,
  type Range,
} from "@tanstack/react-virtual";

export type VirtualChatHandle = {
  bottom: (behavior: ScrollBehavior) => void;
  restore: (anchors: { entryId: string; offset: number }[]) => boolean;
  snapshot: () => VirtualItem[];
};

export function VirtualChatRows<T>({
  rows,
  rowKey,
  renderRow,
  scrollRef,
  handleRef,
  measurements,
  initialOffset,
  estimate = 180,
}: {
  rows: T[];
  rowKey: (row: T) => string;
  renderRow: (row: T) => ReactNode;
  scrollRef?: RefObject<HTMLDivElement>;
  handleRef?: Ref<VirtualChatHandle>;
  measurements?: VirtualItem[];
  initialOffset?: number;
  estimate?: number;
}): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const restoreFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (restoreFrame.current !== null)
        cancelAnimationFrame(restoreFrame.current);
    },
    []
  );
  const [margin, setMargin] = useState(0);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      const focused =
        focusedKey === null
          ? -1
          : rows.findIndex((row) => rowKey(row) === focusedKey);
      if (focused >= 0 && !indexes.includes(focused)) indexes.push(focused);
      return indexes.sort((a, b) => a - b);
    },
    [focusedKey, rows, rowKey]
  );
  const getItemKey = useCallback(
    (index: number) => rowKey(rows[index]!),
    [rowKey, rows]
  );
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () =>
      scrollRef?.current ??
      root.current?.closest<HTMLDivElement>('[data-testid="chat-scroll"]') ??
      null,
    getItemKey,
    rangeExtractor,
    estimateSize: () => estimate,
    overscan: 6,
    scrollMargin: margin,
    anchorTo: "end",
    initialMeasurementsCache: measurements,
    initialOffset,
  });
  virtual.shouldAdjustScrollPositionOnItemSizeChange = (
    item,
    _delta,
    instance
  ) => item.end <= (instance.scrollOffset ?? 0);
  useLayoutEffect(() => {
    const el = root.current;
    const scroller = virtual.scrollElement;
    if (!el || !scroller) return;
    const measureMargin = () =>
      setMargin(
        el.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop
      );
    measureMargin();
    scroller.addEventListener("scroll", measureMargin, { passive: true });
    const observer = new ResizeObserver(measureMargin);
    observer.observe(scroller);
    if (el.parentElement) observer.observe(el.parentElement);
    return () => {
      scroller.removeEventListener("scroll", measureMargin);
      observer.disconnect();
    };
  }, [virtual.scrollElement, rows]);
  useImperativeHandle(
    handleRef,
    () => ({
      bottom: (behavior) => virtual.scrollToEnd({ behavior }),
      restore: (anchors) => {
        for (const anchor of anchors) {
          const index = rows.findIndex((row) => rowKey(row) === anchor.entryId);
          if (index < 0) continue;
          const offset = virtual.getOffsetForIndex(index, "start");
          if (!offset) continue;
          const scroller = virtual.scrollElement;
          const actualMargin =
            root.current && scroller
              ? root.current.getBoundingClientRect().top -
                scroller.getBoundingClientRect().top +
                scroller.scrollTop
              : margin;
          virtual.scrollToOffset(
            offset[0] - anchor.offset + actualMargin - margin
          );
          // The destination's overscan rows are measured after the first jump.
          // Reconcile against the real row, not their former size estimates.
          if (restoreFrame.current !== null)
            cancelAnimationFrame(restoreFrame.current);
          let frames = 0;
          const settle = () => {
            const node = Array.from(root.current?.children ?? []).find(
              (child) =>
                (child as HTMLElement).dataset.virtualRowKey === anchor.entryId
            );
            if (node && scroller) {
              const delta =
                node.getBoundingClientRect().top -
                scroller.getBoundingClientRect().top -
                anchor.offset;
              if (Math.abs(delta) > 1)
                virtual.scrollToOffset(scroller.scrollTop + delta);
            }
            restoreFrame.current =
              ++frames < 4 ? requestAnimationFrame(settle) : null;
          };
          restoreFrame.current = requestAnimationFrame(settle);
          return true;
        }
        return false;
      },
      snapshot: () => virtual.takeSnapshot(),
    }),
    [virtual, rows, rowKey, margin]
  );
  return (
    <div
      ref={root}
      data-testid="virtual-chat-rows"
      onFocusCapture={(event) => {
        let row = event.target as HTMLElement | null;
        while (row && row.parentElement !== event.currentTarget)
          row = row.parentElement;
        if (row) setFocusedKey(row.dataset.virtualRowKey ?? null);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocusedKey(null);
      }}
      style={{
        height: virtual.getTotalSize(),
        position: "relative",
        overflowAnchor: "none",
      }}
    >
      {virtual.getVirtualItems().map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          data-virtual-row-key={String(item.key)}
          ref={virtual.measureElement}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${item.start - margin}px)`,
          }}
        >
          {renderRow(rows[item.index]!)}
        </div>
      ))}
    </div>
  );
}
