import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAtom } from "jotai";
import { ChevronRight, Pin, PinOff, X } from "lucide-react";

import { type FileItem, type SubAgentFiles } from "@/components/app/types";
import { type DrawerTab, drawerWidthAtom } from "@/lib/store";
import { FilesContent } from "@/components/app/files-content";
import { InboxPanel } from "@/components/app/inbox";
import { type Inbox } from "@/hooks/use-inbox";
import { Button } from "@/components/ui/button";
import { glassPanel } from "@/lib/glass";
import { cn } from "@/lib/utils";
import {
  clampDrawerWidth,
  DRAWER_KEYBOARD_BIG_STEP_PX,
  DRAWER_KEYBOARD_STEP_PX,
  DRAWER_MIN_WIDTH_PX,
  DRAWER_TRANSITION_MS,
  DRAWER_WIDTH_PX,
  drawerMaxWidth,
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
  /** The Inbox tab: open inputs and links derived from the stream. */
  inbox: Inbox;
  /** Why the Inbox cannot send an answer right now, or null. */
  inboxDisabledReason: string | null;
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
  inbox,
  inboxDisabledReason,
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
        {
          <div className="flex min-w-0 flex-1">
            <SidebarTab
              label="Inbox"
              active={activeTab === "inbox"}
              onClick={() => setActiveTab("inbox")}
              badge={inbox.inputs.length}
              badgeClassName="bg-status-waiting text-white"
              testId="sidebar-tab-inbox"
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
        }
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
            activeTab !== "inbox" && "hidden"
          )}
        >
          <InboxPanel
            inbox={inbox}
            agentName={selectedAgentName}
            agentNameById={agentNameById}
            disabledReason={inboxDisabledReason}
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

function subscribeViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function useViewportWidth(): number {
  return useSyncExternalStore(
    subscribeViewportWidth,
    () => window.innerWidth,
    () => DRAWER_WIDTH_PX + DRAWER_MIN_WIDTH_PX
  );
}

/**
 * The drawer's width, from the one client-wide preference, clamped to what
 * this viewport allows. `dragWidth` is the width mid-drag: it lives only in
 * the frame being dragged and is written to the preference on release, so a
 * drag is one storage write, not one per pointer move.
 */
function useDrawerWidth() {
  const [storedWidth, setStoredWidth] = useAtom(drawerWidthAtom);
  const viewportWidth = useViewportWidth();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const clamp = useCallback(
    (width: number) => clampDrawerWidth(width, viewportWidth),
    [viewportWidth]
  );
  const width = clamp(dragWidth ?? storedWidth ?? DRAWER_WIDTH_PX);
  return {
    width,
    min: DRAWER_MIN_WIDTH_PX,
    max: drawerMaxWidth(viewportWidth),
    dragging: dragWidth !== null,
    clamp,
    setDragWidth,
    commit: (next: number) => {
      setDragWidth(null);
      setStoredWidth(clamp(next));
    },
  };
}

/**
 * The drawer's left edge, dragged (mouse, pen, touch) or stepped with the
 * arrow keys to resize it. The drawer grows leftward, so moving the pointer
 * left widens it and ArrowLeft does the same.
 */
function DrawerResizeHandle({
  drawerWidth,
}: {
  drawerWidth: ReturnType<typeof useDrawerWidth>;
}): JSX.Element {
  const { width, min, max, clamp, setDragWidth, commit } = drawerWidth;
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    width: number;
  } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // No text selection, and no native drag of whatever is under the edge.
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
      width,
    };
    setDragWidth(width);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.width = clamp(drag.startWidth + (drag.startX - event.clientX));
    setDragWidth(drag.width);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    commit(drag.width);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey
      ? DRAWER_KEYBOARD_BIG_STEP_PX
      : DRAWER_KEYBOARD_STEP_PX;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = width + step;
    else if (event.key === "ArrowRight") next = width - step;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    if (next === null) return;
    event.preventDefault();
    commit(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize drawer"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      data-testid="drawer-resize-handle"
      className="group absolute inset-y-0 left-0 z-10 w-2 -translate-x-1/2 cursor-col-resize touch-none outline-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => commit(DRAWER_WIDTH_PX)}
    >
      <div
        className={cn(
          "mx-auto h-full w-0.5 bg-transparent transition-colors",
          "group-hover:bg-primary/40 group-focus-visible:bg-primary",
          drawerWidth.dragging && "bg-primary/60"
        )}
      />
    </div>
  );
}

/**
 * The slot at the right edge, in the sidebar's mode: pinned, it takes
 * layout width (0 when closed) and shrinks the centre; unpinned, it floats
 * over the centre and slides in from the edge. The sidebar and the thread
 * drawer each sit in one, so a thread takes the sidebar's place while it
 * is open and gives it back on close. Its left edge resizes it, and the
 * width is one preference for the client, shared by every frame.
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
  /**
   * Pinned only: the width transition of an open or close finished. A
   * resize is not an open or close, so it never calls this.
   */
  onWidthTransitionEnd?: () => void;
  children: ReactNode;
  testId?: string;
}): JSX.Element {
  const drawerWidth = useDrawerWidth();
  const { width, dragging } = drawerWidth;
  // Pinned, a resize changes the same `width` an open or close animates, so
  // a keyboard step (which animates) ends in a `transitionend` too. This
  // marks the transitions that are an open or close; only those report.
  const toggleInFlightRef = useRef(false);
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    if (mountedRef.current) toggleInFlightRef.current = true;
    mountedRef.current = true;
  }, [open]);
  // A drag follows the pointer, so it runs with no transition at all. One
  // that starts mid-open cuts that transition short, so no `transitionend`
  // comes for it: the caller's own fallback timer settles it, and the flag
  // must not be left for the next resize to report.
  useLayoutEffect(() => {
    if (dragging) toggleInFlightRef.current = false;
  }, [dragging]);
  const transitionDuration = `${dragging ? 0 : DRAWER_TRANSITION_MS}ms`;
  const handle = open ? <DrawerResizeHandle drawerWidth={drawerWidth} /> : null;

  if (pinned) {
    return (
      <div
        data-testid={testId}
        data-pinned="true"
        data-resizing={dragging ? "true" : undefined}
        className="relative h-full min-w-0 flex-none overflow-hidden transition-[width] ease-out"
        style={{ width: open ? width : 0, transitionDuration }}
        onTransitionEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.propertyName !== "width") return;
          if (!toggleInFlightRef.current) return;
          toggleInFlightRef.current = false;
          onWidthTransitionEnd?.();
        }}
      >
        {handle}
        <div className="h-full min-h-0" style={{ width }}>
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
      data-resizing={dragging ? "true" : undefined}
      className={cn(
        "fixed bottom-0 right-0 top-0 z-30 transition-transform ease-out",
        !open && "pointer-events-none"
      )}
      style={{
        width,
        transform: open ? "translateX(0)" : `translateX(${width}px)`,
        transitionDuration,
      }}
    >
      {handle}
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
