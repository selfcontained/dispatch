import { type ReactNode, type RefObject } from "react";
import { ChevronRight, Pin, PinOff, X } from "lucide-react";

import { type FileItem, type SubAgentFiles } from "@/components/app/types";
import { type DrawerTab } from "@/lib/store";
import { FilesContent } from "@/components/app/files-content";
import { StreamRailPanel } from "@/components/app/stream-rail";
import { type StreamRail } from "@/hooks/use-stream-rail";
import { Button } from "@/components/ui/button";
import { glassPanel } from "@/lib/glass";
import { cn } from "@/lib/utils";
import {
  DRAWER_TRANSITION_MS,
  DRAWER_WIDTH_PX,
} from "@/components/app/drawer-constants";

export {
  DRAWER_SETTLE_FALLBACK_MS,
  DRAWER_TRANSITION_MS,
  DRAWER_WIDTH_PX,
} from "@/components/app/drawer-constants";

type DrawerSharedProps = {
  files: FileItem[];
  selectedAgentId: string | null;
  selectedAgentName: string | null;
  /** Direct children of the selected agent, selectable in its Files tab. */
  subAgentFiles?: SubAgentFiles[];
  /** The selected agent's own files when `files` is showing a sub agent's. */
  ownFiles?: FileItem[];
  filesOwnerId?: string | null;
  onFilesOwnerChange?: (ownerId: string | null) => void;
  animatingFileKeys: Set<string>;
  drawerViewportRef: RefObject<HTMLDivElement>;
  openLightbox: (fileId: number) => void;
  hasStream: boolean;
  streamUrl: string | null;
  unseenFileCount: number;
  onUploadFile?: (agentId: string, file: File) => Promise<void>;
  /** The Rail tab: open inputs and links derived from the stream. */
  rail: StreamRail;
  /** Why the rail cannot send an answer right now, or null. */
  railDisabledReason: string | null;
  /** Names an agent in the selected agent's tree, for a child's question. */
  agentNameById?: (agentId: string) => string;
  /** Opens a block's thread (or a review) in the thread drawer. */
  onOpenBlock?: (blockId: string) => void;
};

type DrawerProps = DrawerSharedProps & {
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  activeTab: DrawerTab;
  setActiveTab: (tab: DrawerTab) => void;
  pinned: boolean;
  onTogglePin: () => void;
  onWidthTransitionEnd?: () => void;
};

type DrawerContentProps = DrawerSharedProps & {
  activeTab: DrawerTab;
  setActiveTab: (tab: DrawerTab) => void;
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

export function DrawerContent({
  files,
  selectedAgentId,
  selectedAgentName,
  subAgentFiles,
  ownFiles,
  filesOwnerId,
  onFilesOwnerChange,
  animatingFileKeys,
  drawerViewportRef,
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
  unseenFileCount,
  onUploadFile,
  rail,
  railDisabledReason,
  agentNameById,
  onOpenBlock,
}: DrawerContentProps & {
  unseenFileCount: number;
}): JSX.Element {
  return (
    <aside
      data-testid="drawer"
      className={cn(
        "flex h-full min-h-0 w-full flex-col text-foreground",
        className
      )}
    >
      {/* Chrome: the home tabs. A thread opens in a drawer of its own. */}
      <div className="flex min-h-14 items-center pt-[env(safe-area-inset-top)]">
        {(
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
              label="Files"
              active={activeTab === "files"}
              onClick={() => setActiveTab("files")}
              badge={unseenFileCount}
              badgeClassName="bg-destructive text-destructive-foreground"
              testId="sidebar-tab-files"
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
              data-testid="toggle-drawer-pin"
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

      <div className="relative flex min-h-0 flex-1 flex-col">
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
            activeTab !== "files" && "hidden"
          )}
        >
          <FilesContent
            files={files}
            ownFiles={ownFiles}
            subAgentFiles={subAgentFiles}
            filesOwnerId={filesOwnerId}
            onFilesOwnerChange={onFilesOwnerChange}
            selectedAgentId={selectedAgentId}
            selectedAgentName={selectedAgentName}
            animatingFileKeys={animatingFileKeys}
            drawerViewportRef={drawerViewportRef}
            openLightbox={openLightbox}
            hasStream={hasStream}
            streamUrl={streamUrl}
            onUploadFile={onUploadFile}
          />
        </div>
      </div>
    </aside>
  );
}

/**
 * The slot at the right edge, in the sidebar's mode: pinned, it takes
 * layout width (0 when closed) and shrinks the centre; unpinned, it floats
 * over the centre and slides in from the edge. The sidebar and the thread
 * drawer each sit in one, so a thread takes the sidebar's place while it
 * is open and gives it back on close.
 */
export function DrawerFrame({
  open,
  pinned,
  onWidthTransitionEnd,
  children,
  testId = "drawer-wrapper",
}: {
  open: boolean;
  pinned: boolean;
  onWidthTransitionEnd?: () => void;
  children: ReactNode;
  testId?: string;
}): JSX.Element {
  if (pinned) {
    return (
      <div
        data-testid={testId}
        data-pinned="true"
        className="h-full min-w-0 flex-none overflow-hidden transition-[width] ease-out"
        style={{
          width: open ? DRAWER_WIDTH_PX : 0,
          transitionDuration: `${DRAWER_TRANSITION_MS}ms`,
        }}
        onTransitionEnd={(event) => {
          if (event.propertyName === "width") {
            onWidthTransitionEnd?.();
          }
        }}
      >
        <div className="h-full min-h-0" style={{ width: DRAWER_WIDTH_PX }}>
          {children}
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
      data-testid={testId}
      data-pinned="false"
      className={cn(
        "fixed bottom-0 right-0 top-0 z-30 transition-transform ease-out",
        !open && "pointer-events-none"
      )}
      style={{
        width: DRAWER_WIDTH_PX,
        transform: open ? "translateX(0)" : `translateX(${DRAWER_WIDTH_PX}px)`,
        transitionDuration: `${DRAWER_TRANSITION_MS}ms`,
      }}
    >
      {children}
    </div>
  );
}

export function Drawer({
  drawerOpen,
  setDrawerOpen,
  pinned,
  onTogglePin,
  onWidthTransitionEnd,
  ...props
}: DrawerProps): JSX.Element {
  return (
    <DrawerFrame
      open={drawerOpen}
      pinned={pinned}
      onWidthTransitionEnd={onWidthTransitionEnd}
    >
      <DrawerContent
        {...props}
        onRequestClose={() => setDrawerOpen(false)}
        closeButtonIcon="chevron"
        pinned={pinned}
        onTogglePin={onTogglePin}
        className={cn(
          "rounded-l-lg border-l",
          !pinned && "shadow-2xl",
          glassPanel
        )}
      />
    </DrawerFrame>
  );
}
