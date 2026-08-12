import { type RefObject } from "react";
import { ChevronRight, Pin, PinOff, X } from "lucide-react";

import { type AgentPin, type MediaFile } from "@/components/app/types";
import { type MediaSidebarTab } from "@/lib/store";
import { MediaContent } from "@/components/app/media-content";
import { MessagesPanel } from "@/components/app/messages-panel";
import { PinsPanel } from "@/components/app/pins-panel";
import { ReviewsSidebarContent } from "@/components/app/reviews-sidebar";
import { useAgentReviews } from "@/hooks/use-agent-reviews";
import { useRunPinShortcut } from "@/hooks/use-pin-shortcuts";
import { Button } from "@/components/ui/button";
import { glassPanel } from "@/lib/glass";
import { cn } from "@/lib/utils";
import {
  MEDIA_SIDEBAR_TRANSITION_MS,
  MEDIA_SIDEBAR_WIDTH_PX,
} from "@/components/app/media-sidebar-constants";

export {
  MEDIA_SIDEBAR_SETTLE_FALLBACK_MS,
  MEDIA_SIDEBAR_TRANSITION_MS,
  MEDIA_SIDEBAR_WIDTH_PX,
} from "@/components/app/media-sidebar-constants";

type MediaSidebarSharedProps = {
  mediaFiles: MediaFile[];
  selectedAgentId: string | null;
  selectedAgentName: string | null;
  selectedAgentWorkspaceRoot: string | null;
  selectedAgentPins: AgentPin[];
  selectedAgentIsRunning?: boolean;
  animatingMediaKeys: Set<string>;
  mediaViewportRef: RefObject<HTMLDivElement>;
  openLightbox: (file: MediaFile) => void;
  hasStream: boolean;
  streamUrl: string | null;
  unseenMediaCount: number;
  unreadMessageCount: number;
  onUploadFile?: (agentId: string, file: File) => Promise<void>;
  onNavigateToFile?: (
    filePath: string,
    lineStart: number | null,
    feedbackItemId?: number
  ) => void;
  /** Called after a shortcut successfully fires (mobile closes the sheet). */
  onShortcutRun?: () => void;
};

type MediaSidebarProps = MediaSidebarSharedProps & {
  mediaOpen: boolean;
  setMediaOpen: (open: boolean) => void;
  activeTab: MediaSidebarTab;
  setActiveTab: (tab: MediaSidebarTab) => void;
  pinned: boolean;
  onTogglePin: () => void;
  onWidthTransitionEnd?: () => void;
};

type MediaSidebarContentProps = MediaSidebarSharedProps & {
  activeTab: MediaSidebarTab;
  setActiveTab: (tab: MediaSidebarTab) => void;
  onRequestClose?: () => void;
  closeButtonIcon?: "chevron" | "x";
  pinned?: boolean;
  onTogglePin?: () => void;
  className?: string;
};

export function MediaSidebarContent({
  mediaFiles,
  selectedAgentId,
  selectedAgentName,
  selectedAgentWorkspaceRoot,
  selectedAgentPins,
  selectedAgentIsRunning,
  animatingMediaKeys,
  mediaViewportRef,
  openLightbox,
  hasStream,
  streamUrl,
  activeTab,
  setActiveTab,
  onRequestClose,
  closeButtonIcon = "x",
  pinned,
  onTogglePin,
  className,
  unseenMediaCount,
  unreadMessageCount,
  onUploadFile,
  onNavigateToFile,
  onShortcutRun,
}: MediaSidebarContentProps & {
  unseenMediaCount: number;
  unreadMessageCount: number;
}): JSX.Element {
  const { reviews } = useAgentReviews(selectedAgentId, !!selectedAgentId);
  const runPinShortcut = useRunPinShortcut();
  const reviewUnresolvedCount = reviews.reduce(
    (sum, r) => sum + (r.itemCount - r.resolvedCount),
    0
  );
  return (
    <aside
      data-testid="media-sidebar"
      className={cn(
        "flex h-full min-h-0 w-full flex-col text-foreground",
        className
      )}
    >
      {/* Tab header */}
      <div className="flex min-h-14 items-center pt-[env(safe-area-inset-top)]">
        <div className="flex min-w-0 flex-1">
          <button
            onClick={() => setActiveTab("pins")}
            className={cn(
              "relative flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide transition-colors",
              activeTab === "pins"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground/80"
            )}
          >
            Pins
            {activeTab === "pins" ? (
              <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground" />
            ) : null}
            {selectedAgentPins.length > 0 && (
              <span className="absolute top-0 right-0 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[8px] text-primary-foreground">
                {selectedAgentPins.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab("media")}
            className={cn(
              "relative flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide transition-colors",
              activeTab === "media"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground/80"
            )}
          >
            Media
            {activeTab === "media" ? (
              <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground" />
            ) : null}
            {unseenMediaCount > 0 && (
              <span className="absolute top-0 right-0 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[8px] text-destructive-foreground">
                {unseenMediaCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab("reviews")}
            className={cn(
              "relative flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide transition-colors",
              activeTab === "reviews"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground/80"
            )}
          >
            Reviews
            {activeTab === "reviews" ? (
              <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground" />
            ) : null}
            {reviewUnresolvedCount > 0 && (
              <span className="absolute top-0 right-0 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[8px] text-white">
                {reviewUnresolvedCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab("messages")}
            className={cn(
              "relative flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide transition-colors",
              activeTab === "messages"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground/80"
            )}
          >
            Messages
            {activeTab === "messages" ? (
              <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground" />
            ) : null}
            {unreadMessageCount > 0 && (
              <span className="absolute top-0 right-0 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[8px] text-destructive-foreground">
                {unreadMessageCount}
              </span>
            )}
          </button>
        </div>
        <div className="flex items-center gap-1 px-2">
          {onTogglePin ? (
            <Button
              size="icon"
              variant="ghost"
              onClick={onTogglePin}
              title={pinned ? "Unpin sidebar" : "Pin sidebar"}
              aria-label={pinned ? "Unpin sidebar" : "Pin sidebar"}
              aria-pressed={pinned ?? false}
              data-testid="toggle-media-sidebar-pin"
              data-pinned={pinned ? "true" : "false"}
              className="h-7 w-7"
            >
              {pinned ? (
                <PinOff className="h-4 w-4" />
              ) : (
                <Pin className="h-4 w-4" />
              )}
            </Button>
          ) : null}
          {onRequestClose ? (
            <Button
              size="icon"
              variant="ghost"
              onClick={onRequestClose}
              title="Close sidebar"
              className="h-7 w-7"
            >
              {closeButtonIcon === "chevron" ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <X className="h-4 w-4" />
              )}
            </Button>
          ) : null}
        </div>
      </div>

      {/* Tab content — both panels stay mounted so refs (e.g. IntersectionObserver) remain attached */}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          activeTab !== "pins" && "hidden"
        )}
      >
        <PinsPanel
          pins={selectedAgentPins}
          selectedAgentName={selectedAgentName}
          selectedAgentWorkspaceRoot={selectedAgentWorkspaceRoot}
          agentIsRunning={selectedAgentIsRunning}
          {...(selectedAgentId ? { collapseScope: selectedAgentId } : {})}
          // A shortcut fires a real prompt into a live session, so an
          // in-flight run blocks its own button until it settles — a
          // double-click would otherwise send the prompt twice.
          pendingPinId={
            runPinShortcut.isPending
              ? (runPinShortcut.variables?.pinId ?? null)
              : null
          }
          onRunShortcut={
            selectedAgentId
              ? (pin) => {
                  if (!pin.id || runPinShortcut.isPending) return;
                  runPinShortcut.mutate(
                    {
                      agentId: selectedAgentId,
                      pinId: pin.id,
                      label: pin.label,
                    },
                    { onSuccess: () => onShortcutRun?.() }
                  );
                }
              : undefined
          }
        />
      </div>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          activeTab !== "media" && "hidden"
        )}
      >
        <MediaContent
          mediaFiles={mediaFiles}
          selectedAgentId={selectedAgentId}
          animatingMediaKeys={animatingMediaKeys}
          mediaViewportRef={mediaViewportRef}
          openLightbox={openLightbox}
          hasStream={hasStream}
          streamUrl={streamUrl}
          onUploadFile={onUploadFile}
        />
      </div>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          activeTab !== "reviews" && "hidden"
        )}
      >
        <ReviewsSidebarContent
          agentId={selectedAgentId}
          onNavigateToFile={onNavigateToFile}
        />
      </div>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          activeTab !== "messages" && "hidden"
        )}
      >
        <MessagesPanel agentId={selectedAgentId} />
      </div>
    </aside>
  );
}

export function MediaSidebar({
  mediaOpen,
  setMediaOpen,
  pinned,
  onTogglePin,
  onWidthTransitionEnd,
  ...props
}: MediaSidebarProps): JSX.Element {
  if (pinned) {
    // Inline mode: takes layout space and shrinks the terminal.
    return (
      <div
        data-testid="media-sidebar-wrapper"
        data-pinned="true"
        className="h-full min-w-0 flex-none overflow-hidden transition-[width] ease-out"
        style={{
          width: mediaOpen ? MEDIA_SIDEBAR_WIDTH_PX : 0,
          transitionDuration: `${MEDIA_SIDEBAR_TRANSITION_MS}ms`,
        }}
        onTransitionEnd={(event) => {
          if (event.propertyName === "width") {
            onWidthTransitionEnd?.();
          }
        }}
      >
        <div
          className="h-full min-h-0"
          style={{ width: MEDIA_SIDEBAR_WIDTH_PX }}
        >
          <MediaSidebarContent
            {...props}
            onRequestClose={() => setMediaOpen(false)}
            closeButtonIcon="chevron"
            pinned={pinned}
            onTogglePin={onTogglePin}
            className={cn("rounded-l-lg border-l", glassPanel)}
          />
        </div>
      </div>
    );
  }

  // Drawer mode: floats over the terminal, slides in/out without shifting
  // layout. The panel is positioned absolutely against the agents-view flex
  // container (which sets `position: relative`), so it has a real hit-testable
  // box at the right edge instead of being anchored inside a 0-width wrapper.
  return (
    <div
      data-testid="media-sidebar-wrapper"
      data-pinned="false"
      className={cn(
        "absolute bottom-0 right-0 top-0 z-30 transition-transform ease-out",
        !mediaOpen && "pointer-events-none"
      )}
      style={{
        width: MEDIA_SIDEBAR_WIDTH_PX,
        transform: mediaOpen
          ? "translateX(0)"
          : `translateX(${MEDIA_SIDEBAR_WIDTH_PX}px)`,
        transitionDuration: `${MEDIA_SIDEBAR_TRANSITION_MS}ms`,
      }}
    >
      <MediaSidebarContent
        {...props}
        onRequestClose={() => setMediaOpen(false)}
        closeButtonIcon="chevron"
        pinned={pinned}
        onTogglePin={onTogglePin}
        className={cn("rounded-l-lg border-l shadow-2xl", glassPanel)}
      />
    </div>
  );
}
