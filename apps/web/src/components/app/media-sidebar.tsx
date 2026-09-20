import { type RefObject, useMemo } from "react";
import { MotionConfig } from "framer-motion";
import { ArrowLeft, ChevronRight, Pin, PinOff, X } from "lucide-react";

import { threadTitle } from "@/components/app/chat/thread-panel";
import {
  DrawerStack,
  type DrawerPage,
} from "@/components/app/drawer/drawer-stack";
import { ThreadPage } from "@/components/app/drawer/thread-page";
import {
  type Agent,
  type MediaFile,
  type SubAgentMedia,
} from "@/components/app/types";
import { type MediaSidebarTab } from "@/lib/store";
import { MediaContent } from "@/components/app/media-content";
import { StreamRailPanel } from "@/components/app/stream-rail";
import { useDrawerRoute } from "@/hooks/use-drawer-route";
import { useThread } from "@/hooks/use-stream";
import { type StreamRail } from "@/hooks/use-stream-rail";
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
  /** Direct children of the selected agent, selectable in its Media tab. */
  subAgentMedia?: SubAgentMedia[];
  /** The selected agent's own files when `mediaFiles` is showing a sub agent's. */
  ownMediaFiles?: MediaFile[];
  mediaOwnerId?: string | null;
  onMediaOwnerChange?: (ownerId: string | null) => void;
  animatingMediaKeys: Set<string>;
  mediaViewportRef: RefObject<HTMLDivElement>;
  openLightbox: (mediaId: number) => void;
  hasStream: boolean;
  streamUrl: string | null;
  unseenMediaCount: number;
  onUploadFile?: (agentId: string, file: File) => Promise<void>;
  /** The Rail tab: open inputs and links derived from the stream. */
  rail: StreamRail;
  /** Why the rail cannot send an answer right now, or null. */
  railDisabledReason: string | null;
  /** Names an agent in the selected agent's tree, for a child's question. */
  agentNameById?: (agentId: string) => string;
  /** Pushes a block's thread (or a review) over the drawer's home page. */
  onOpenBlock?: (blockId: string) => void;
  /** The page's agent: the thread pages post as it and read its state. */
  agent?: Agent | null;
  /** Opens the Changes tab on a file, at a line when one is given. */
  onOpenPath?: (path: string, line: number | null) => void;
  isMobile?: boolean;
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

function SidebarTab({
  label,
  active,
  onClick,
  badge,
  badgeClassName,
  testId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
  badgeClassName?: string;
  testId: string;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      aria-pressed={active}
      className={cn(
        "relative flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide transition-colors",
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground/80"
      )}
    >
      {label}
      {active ? (
        <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground" />
      ) : null}
      {badge !== undefined && badge > 0 ? (
        <span
          className={cn(
            "absolute top-0 right-0 flex h-4 w-4 items-center justify-center rounded-full text-[8px]",
            badgeClassName ?? "bg-primary text-primary-foreground"
          )}
          data-testid={`${testId}-badge`}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function MediaSidebarContent({
  mediaFiles,
  selectedAgentId,
  selectedAgentName,
  subAgentMedia,
  ownMediaFiles,
  mediaOwnerId,
  onMediaOwnerChange,
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
  onUploadFile,
  rail,
  railDisabledReason,
  agentNameById,
  onOpenBlock,
  agent = null,
  onOpenPath,
  isMobile = false,
}: MediaSidebarContentProps & {
  unseenMediaCount: number;
}): JSX.Element {
  // The pages over the home tabs come from the URL: a thread (or a review),
  // and a finding on that review.
  const route = useDrawerRoute();
  const rootId = rail.rootId;
  const threadId = selectedAgentId && rootId ? route.threadId : null;
  const findingId = threadId ? route.findingId : null;
  const thread = useThread(rootId, threadId);
  const nameOf = (agentId: string) =>
    agentId === selectedAgentId
      ? (selectedAgentName ?? "Agent")
      : (agentNameById?.(agentId) ?? "Agent");
  const heading = threadTitle(thread.root, findingId !== null, nameOf);
  const { openThread, back } = route;
  const pages = useMemo<DrawerPage[]>(() => {
    const list: DrawerPage[] = [{ key: "home", node: null }];
    if (!selectedAgentId || !rootId || !threadId) return list;
    // One page per level: moving between findings on the same review
    // changes what the finding page shows rather than swapping pages.
    const page = (finding: string | null): DrawerPage => ({
      key: finding ? `finding:${threadId}` : `thread:${threadId}`,
      node: (
        <ThreadPage
          agentId={selectedAgentId}
          agent={agent}
          rootId={rootId}
          blockId={threadId}
          findingId={finding}
          isMobile={isMobile}
          openLightbox={openLightbox}
          onOpenPath={onOpenPath}
          onOpenThread={openThread}
          onBack={back}
        />
      ),
    });
    list.push(page(null));
    if (findingId) list.push(page(findingId));
    return list;
  }, [
    agent,
    back,
    findingId,
    isMobile,
    onOpenPath,
    openLightbox,
    openThread,
    rootId,
    selectedAgentId,
    threadId,
  ]);
  const depth = pages.length - 1;

  return (
    <aside
      data-testid="media-sidebar"
      data-depth={depth}
      className={cn(
        "flex h-full min-h-0 w-full flex-col text-foreground",
        className
      )}
    >
      {/* Chrome: the home tabs, or the page's title with the way back */}
      <div className="flex min-h-14 items-center pt-[env(safe-area-inset-top)]">
        {depth > 0 ? (
          <div className="flex min-w-0 flex-1 items-center gap-1 pl-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label="Back"
              data-testid="drawer-back"
              onClick={back}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
            <div className="min-w-0 flex-1">
              <div
                className="truncate text-sm font-semibold text-foreground"
                data-testid="drawer-title"
              >
                {heading.title}
              </div>
              {heading.subtitle ? (
                <div
                  className="truncate text-[11.5px] text-muted-foreground"
                  data-testid="drawer-subtitle"
                >
                  {heading.subtitle}
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-1">
            <SidebarTab
              label="Rail"
              active={activeTab === "rail"}
              onClick={() => setActiveTab("rail")}
              badge={rail.inputs.length}
              badgeClassName="bg-status-waiting text-white"
              testId="sidebar-tab-rail"
            />
            <SidebarTab
              label="Media"
              active={activeTab === "media"}
              onClick={() => setActiveTab("media")}
              badge={unseenMediaCount}
              badgeClassName="bg-destructive text-destructive-foreground"
              testId="sidebar-tab-media"
            />
          </div>
        )}
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

      <MotionConfig reducedMotion="user">
        <DrawerStack
          pages={pages.map((page, index) =>
            index === 0
              ? {
                  key: page.key,
                  node: (
                    <>
                      {/* Both tabs stay mounted so refs (e.g. IntersectionObserver) remain attached */}
                      <div
                        className={cn(
                          "flex min-h-0 flex-1 flex-col",
                          activeTab !== "rail" && "hidden"
                        )}
                      >
                        <StreamRailPanel
                          rail={rail}
                          agentName={selectedAgentName}
                          agentNameById={agentNameById}
                          disabledReason={railDisabledReason}
                          onOpenBlock={onOpenBlock}
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
                          ownMediaFiles={ownMediaFiles}
                          subAgentMedia={subAgentMedia}
                          mediaOwnerId={mediaOwnerId}
                          onMediaOwnerChange={onMediaOwnerChange}
                          selectedAgentId={selectedAgentId}
                          selectedAgentName={selectedAgentName}
                          animatingMediaKeys={animatingMediaKeys}
                          mediaViewportRef={mediaViewportRef}
                          openLightbox={openLightbox}
                          hasStream={hasStream}
                          streamUrl={streamUrl}
                          onUploadFile={onUploadFile}
                        />
                      </div>
                    </>
                  ),
                }
              : page
          )}
        />
      </MotionConfig>
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
  // layout. Anchored to the viewport rather than to the agents-view row, the
  // same way the mobile slide-over in glass-sidebar.tsx is. That is what keeps
  // the closed panel — parked off-canvas to the right — from counting as
  // scrollable overflow on the row: a fixed box's containing block is the
  // viewport, so it contributes none. As an absolute child it did, leaving the
  // row a scroll container that any descendant `scrollIntoView` would scroll,
  // dragging the whole app sideways.
  return (
    <div
      data-testid="media-sidebar-wrapper"
      data-pinned="false"
      className={cn(
        "fixed bottom-0 right-0 top-0 z-30 transition-transform ease-out",
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
