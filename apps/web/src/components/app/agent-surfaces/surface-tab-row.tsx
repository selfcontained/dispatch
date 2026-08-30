import { useEffect, useRef, useState } from "react";
import { Bot, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { useSurfaceTabPrefs } from "@/components/app/agent-surfaces/use-surface-tab-prefs";
import { useSurfaceSeen } from "@/components/app/agent-surfaces/use-surface-seen";
import { ManageTabsMenu } from "@/components/app/agent-surfaces/manage-tabs-menu";
import { SurfaceIconGlyph } from "@/components/app/agent-surfaces/surface-icon";
import type { Surface } from "@/components/app/agent-surfaces/types";
import type { MediaSidebarTab } from "@/lib/store";

const EDGE_FADE_WIDTH = "24px";

/**
 * CSS mask fading the scroll strip's own edges toward transparent wherever
 * more tabs sit off-canvas — a `mask-image`, not a background gradient, so it
 * reads correctly over the sidebar's translucent glass panel in both themes
 * without having to match a background color. Undefined (no mask) when the
 * strip has nothing overflowing.
 */
export function edgeFadeMask(
  left: boolean,
  right: boolean
): string | undefined {
  if (!left && !right) return undefined;
  const stops = [
    left ? "transparent 0" : "black 0",
    ...(left ? [`black ${EDGE_FADE_WIDTH}`] : []),
    ...(right ? [`black calc(100% - ${EDGE_FADE_WIDTH})`] : []),
    right ? "transparent 100%" : "black 100%",
  ];
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

/**
 * Compact "these tabs came from the agent" marker, fixed at the start of the
 * strip so it never scrolls out of view with the tabs. The short text label
 * stays visible on mobile: provenance is more important than fitting one
 * additional title in a rail that already scrolls horizontally.
 */
function SurfaceProvenanceMarker(): JSX.Element {
  return (
    <div
      data-testid="surface-provenance-marker"
      title="Tabs authored by the agent"
      className="flex h-11 shrink-0 items-center gap-1 rounded bg-primary/10 px-1.5 text-primary md:h-7 [@media(pointer:coarse)]:h-11"
    >
      <span className="relative flex h-3.5 w-3.5 items-center justify-center">
        <Bot className="h-3.5 w-3.5" aria-hidden="true" />
        <Sparkles
          className="absolute -right-1 -top-1 h-2 w-2 text-primary"
          aria-hidden="true"
        />
      </span>
      <span className="text-[10px] font-medium uppercase tracking-wide">
        Agent
      </span>
    </div>
  );
}

/**
 * Second compact tab row for agent-authored custom tabs, rendered beneath
 * the fixed Pins/Media/Reviews/Messages row. Renders nothing when the agent
 * has no custom tabs, so it never adds height to sidebars that don't need it.
 *
 * The surface data is owned by the sidebar's query hook. This component owns
 * only the row's presentation and local interaction behavior.
 */
export function SurfaceTabRow({
  agentId,
  activeTab,
  setActiveTab,
  surfaces,
  isSidebarVisible,
}: {
  agentId: string | null;
  activeTab: MediaSidebarTab;
  setActiveTab: (tab: MediaSidebarTab) => void;
  surfaces: Surface[];
  /** Re-scrolls the active surface when an off-canvas sidebar opens. */
  isSidebarVisible?: boolean;
}): JSX.Element | null {
  const activeSurfaceId = surfaces.some((s) => s.id === activeTab)
    ? activeTab
    : null;
  const prefs = useSurfaceTabPrefs(agentId, surfaces);
  const { isNew, markSeen } = useSurfaceSeen(agentId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  // The active tab has, by definition, been viewed — clear its "new" flag
  // as soon as it becomes current.
  useEffect(() => {
    if (activeSurfaceId) markSeen(activeSurfaceId);
  }, [activeSurfaceId, markSeen]);

  // Dynamic overflow affordance: fade the strip's edges wherever more tabs
  // sit off-canvas, clearing at whichever edge is actually reached. Kept
  // independent of the active-tab-scroll effect below — it must still track
  // overflow when the active center-pane tab isn't a custom surface at all
  // (e.g. Pins), not only while a surface tab is selected.
  useEffect(() => {
    const strip = scrollRef.current;
    if (!strip) return;

    const updateOverflow = () => {
      const hasOverflow = strip.scrollWidth > strip.clientWidth + 1;
      setOverflow({
        left: hasOverflow && strip.scrollLeft > 1,
        right:
          hasOverflow &&
          strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1,
      });
    };

    updateOverflow();
    strip.addEventListener("scroll", updateOverflow, { passive: true });
    const resizeObserver = new ResizeObserver(updateOverflow);
    resizeObserver.observe(strip);
    return () => {
      strip.removeEventListener("scroll", updateOverflow);
      resizeObserver.disconnect();
    };
  }, [prefs.visibleTabs, isSidebarVisible]);

  // Keep the active tab in view when it is selected or when the strip changes
  // width (for example, while switching to the mobile sidebar). Without the
  // resize observer, an active tab that was visible in a desktop sidebar can
  // be left outside the smaller mobile viewport.
  useEffect(() => {
    if (!activeSurfaceId) return;

    const scrollActiveTabIntoView = () => {
      const button = scrollRef.current?.querySelector<HTMLElement>(
        `[data-surface-id="${activeSurfaceId}"]`
      );
      button?.scrollIntoView({ block: "nearest", inline: "nearest" });
    };

    scrollActiveTabIntoView();
    const scrollStrip = scrollRef.current;
    if (!scrollStrip) return;

    const resizeObserver = new ResizeObserver(scrollActiveTabIntoView);
    resizeObserver.observe(scrollStrip);
    return () => resizeObserver.disconnect();
  }, [activeSurfaceId, isSidebarVisible]);

  if (!agentId || surfaces.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="surface-tab-row"
      className="flex min-w-0 items-center gap-1 border-t border-border/40 px-2 py-1"
    >
      <SurfaceProvenanceMarker />
      <div
        ref={scrollRef}
        data-testid="surface-tab-scroll"
        data-overflow-left={overflow.left ? "true" : "false"}
        data-overflow-right={overflow.right ? "true" : "false"}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{
          maskImage: edgeFadeMask(overflow.left, overflow.right),
          WebkitMaskImage: edgeFadeMask(overflow.left, overflow.right),
        }}
      >
        {prefs.visibleTabs.map((surface) => {
          const isActive = activeTab === surface.id;
          const isUnseen = isNew(surface.id);
          return (
            <button
              key={surface.id}
              type="button"
              onClick={() => setActiveTab(surface.id)}
              aria-current={isActive ? "true" : undefined}
              title={surface.title}
              data-testid="surface-tab-button"
              data-surface-id={surface.id}
              data-new={isUnseen ? "true" : "false"}
              className={cn(
                "relative flex h-11 shrink-0 items-center gap-1 rounded px-2 text-[11px] transition-colors md:h-7 [@media(pointer:coarse)]:h-11",
                isActive
                  ? "bg-muted font-semibold text-foreground"
                  : "font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              )}
            >
              <SurfaceIconGlyph
                icon={surface.icon}
                className="h-3 w-3 shrink-0"
              />
              <span className="max-w-[110px] truncate">{surface.title}</span>
              {surface.unresolvedInteractionCount > 0 ? (
                <span
                  aria-label={`${surface.unresolvedInteractionCount} pending`}
                  className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-primary text-[8px] text-primary-foreground"
                >
                  {surface.unresolvedInteractionCount}
                </span>
              ) : null}
              {isActive ? (
                <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-primary" />
              ) : null}
              {isUnseen ? (
                <span
                  aria-label="New"
                  className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary ring-2 ring-background"
                />
              ) : null}
            </button>
          );
        })}
      </div>
      {prefs.managedTabs.length > 0 ? (
        <ManageTabsMenu
          managedTabs={prefs.managedTabs}
          activeTabId={activeSurfaceId}
          onSelectTab={(id) => {
            // A hidden tab has no button in the strip — activating it
            // without unhiding would leave content on screen with nothing
            // shown as selected. Unhide it first so it's visibly current.
            const target = prefs.managedTabs.find(
              ({ surface }) => surface.id === id
            );
            if (target?.hidden) {
              prefs.toggleHidden(id);
            }
            setActiveTab(id);
          }}
          hiddenCount={prefs.hiddenCount}
          isNew={isNew}
          moveTabEarlier={prefs.moveTabEarlier}
          moveTabLater={prefs.moveTabLater}
          toggleHidden={(id) => {
            const target = prefs.managedTabs.find(
              ({ surface }) => surface.id === id
            );
            if (id === activeSurfaceId && target && !target.hidden) {
              const fallback = prefs.managedTabs.find(
                ({ surface, hidden }) => surface.id !== id && !hidden
              );
              setActiveTab(fallback?.surface.id ?? "pins");
            }
            prefs.toggleHidden(id);
          }}
          resetOrder={prefs.resetOrder}
        />
      ) : null}
    </div>
  );
}
