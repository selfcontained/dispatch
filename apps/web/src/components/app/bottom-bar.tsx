import { ChevronDown, ChevronUp } from "lucide-react";
import { useAtom } from "jotai";

import { AmbientTipBar } from "@/components/tips/ambient-tip-bar";
import { bottomBarCollapsedAtom } from "@/lib/store";

/**
 * Desktop-only bar under the center pane, hosting the ambient tip bar.
 * Collapsible (not removable) to free vertical space for the content area;
 * the collapsed state persists per device. When collapsed, a slim expand
 * chevron stays in the bottom-right corner.
 */
export function BottomBar(): JSX.Element {
  const [collapsed, setCollapsed] = useAtom(bottomBarCollapsedAtom);

  if (collapsed) {
    // z-30: with the bar collapsed the terminal pane reaches the bottom edge,
    // and its inert/empty overlays are z-20 — the expand control must stay
    // clickable above them.
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        title="Expand bottom bar"
        aria-label="Expand bottom bar"
        aria-expanded={false}
        data-testid="bottom-bar-expand"
        className="pointer-events-auto absolute bottom-0 right-2 z-30 flex h-5 w-8 items-center justify-center rounded-t-md text-muted-foreground/40 transition-colors hover:bg-muted hover:text-foreground"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    <div
      data-testid="bottom-bar"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex h-14 items-center bg-background"
    >
      <div className="h-full min-w-0 flex-1">
        <AmbientTipBar />
      </div>
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        title="Collapse bottom bar"
        aria-label="Collapse bottom bar"
        aria-expanded={true}
        data-testid="bottom-bar-collapse"
        className="pointer-events-auto mr-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/40 transition-colors hover:bg-muted hover:text-foreground"
      >
        <ChevronDown className="h-4 w-4" />
      </button>
    </div>
  );
}
