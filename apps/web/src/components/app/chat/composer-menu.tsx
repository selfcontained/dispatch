import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The popup the composer shows above the field for a token menu: the
 * slash commands and the "@" path picker are the same listbox with
 * different rows. The host keeps the active index and the pick; this only
 * draws the rows and keeps the field focused on a click.
 */
export function ComposerMenu<T>({
  items,
  activeIndex,
  onPick,
  onHover,
  keyOf,
  renderItem,
  ariaLabel,
  testId,
  itemTestId,
  itemData,
  scroll = false,
}: {
  items: T[];
  activeIndex: number;
  onPick: (item: T) => void;
  onHover: (index: number) => void;
  keyOf: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  ariaLabel: string;
  testId: string;
  itemTestId: string;
  /** Extra data-* attributes per row, for tests and styling hooks. */
  itemData?: (item: T) => Record<string, string | undefined>;
  /** Cap the height and scroll: for lists that can run long. */
  scroll?: boolean;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  // A long list scrolls; the arrow keys must keep the active row in view.
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(
      '[aria-selected="true"]'
    );
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, items]);
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        "absolute bottom-full left-0 z-20 mb-1 w-full max-w-md rounded-md border border-border bg-popover text-popover-foreground shadow-md",
        scroll ? "max-h-72 overflow-y-auto" : "overflow-hidden"
      )}
    >
      {items.map((item, i) => (
        <button
          key={keyOf(item)}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          data-testid={itemTestId}
          {...(itemData ? itemData(item) : {})}
          onMouseDown={(event) => {
            // Keep the field's focus; a click picks like Enter does.
            event.preventDefault();
            onPick(item);
          }}
          onMouseEnter={() => onHover(i)}
          className={cn(
            "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs pointer-coarse:min-h-11 pointer-coarse:py-2.5",
            // The accent token is a hair off the popover in the dark
            // themes, so the active row takes the working color instead:
            // a tint plus a bar at the left edge.
            i === activeIndex
              ? "bg-status-working/15 text-foreground shadow-[inset_2px_0_0_hsl(var(--status-working))]"
              : ""
          )}
        >
          {renderItem(item)}
        </button>
      ))}
      <div
        aria-hidden="true"
        className="sticky bottom-0 border-t border-border/60 bg-popover px-2.5 py-1 text-[10.5px] text-muted-foreground"
      >
        ↑↓ move · Enter picks · Esc closes
      </div>
    </div>
  );
}
