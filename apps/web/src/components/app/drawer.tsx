import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAtom } from "jotai";
import { Pin, PinOff } from "lucide-react";

import { type FileItem, type SubAgentFiles } from "@/components/app/types";
import { type DrawerTab, drawerWidthAtom } from "@/lib/store";
import { TerminalLazyBoundary } from "@/components/terminal/terminal-lazy-boundary";
import { FilesContent, type FilesState } from "@/components/app/files-content";
import { InboxPanel } from "@/components/app/inbox";
import { type Inbox } from "@/hooks/use-inbox";
import { cn } from "@/lib/utils";
import {
  clampDrawerWidth,
  DRAWER_EDGE_GUTTER_PX,
  DRAWER_KEYBOARD_BIG_STEP_PX,
  DRAWER_KEYBOARD_STEP_PX,
  DRAWER_MIN_WIDTH_PX,
  DRAWER_WIDTH_PX,
  drawerMaxWidth,
  drawerPinnedReserve,
} from "@/components/app/drawer-constants";
import { CountBubble } from "@/components/ui/count-bubble";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetClose, type SheetProps } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type DrawerSharedProps = {
  files: FileItem[];
  selectedAgentId: string | null;
  selectedAgentName: string | null;
  /** Direct children of the selected agent, selectable in its Files tab. */
  subAgentFiles?: SubAgentFiles[];
  /** The selected agent's own files when `files` is showing a sub agent's. */
  ownFiles?: FileItem[];
  filesOwnerId?: string | null;
  filesState?: FilesState;
  onFilesOwnerChange?: (ownerId: string | null) => void;
  animatingFileKeys: Set<string>;
  drawerViewportRef: RefObject<HTMLDivElement>;
  openLightbox: (fileId: number, order?: number[]) => void;
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
  pinnedReserve?: number;
};

type DrawerContentProps = DrawerSharedProps & {
  visible?: boolean;
  activeTab: DrawerTab;
  setActiveTab: (tab: DrawerTab) => void;
  onRequestClose?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  className?: string;
};

export function DrawerContent({
  files,
  selectedAgentId,
  selectedAgentName,
  subAgentFiles,
  ownFiles,
  filesOwnerId,
  filesState,
  onFilesOwnerChange,
  animatingFileKeys,
  drawerViewportRef,
  openLightbox,
  hasStream,
  streamUrl,
  activeTab,
  visible = true,
  setActiveTab,
  onRequestClose,
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
      <Tabs
        value={activeTab}
        onValueChange={(tab) => setActiveTab(tab as DrawerTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* Chrome: the home tabs. A thread opens in a drawer of its own. */}
        <div className="flex min-h-14 items-center pt-safe">
          <TabsList
            aria-label="Drawer"
            className="min-w-0 flex-1 self-stretch pl-1"
          >
            <TabsTrigger value="inbox" data-testid="sidebar-tab-inbox">
              Inbox
              {inbox.inputs.length > 0 ? (
                <CountBubble
                  tone="warning"
                  count={inbox.inputs.length}
                  data-testid="sidebar-tab-inbox-badge"
                />
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="files" data-testid="sidebar-tab-files">
              Files
              {unseenFileCount > 0 ? (
                <CountBubble
                  tone="info"
                  count={unseenFileCount}
                  data-testid="sidebar-tab-files-badge"
                />
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="terminal" data-testid="sidebar-tab-terminal">
              Terminal
            </TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-1 px-2">
            {onTogglePin ? (
              <IconButton
                size="icon-sm"
                onClick={onTogglePin}
                label={pinned ? "Unpin sidebar" : "Pin sidebar"}
                pressed={pinned ?? false}
                data-testid="toggle-drawer-pin"
                data-pinned={pinned ? "true" : "false"}
              >
                {pinned ? <PinOff /> : <Pin />}
              </IconButton>
            ) : null}
            {onRequestClose ? <SheetClose onClick={onRequestClose} /> : null}
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col">
          <TabsContent
            forceMount
            value="terminal"
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              activeTab !== "terminal" && "hidden"
            )}
          >
            {selectedAgentId && (
              <TerminalLazyBoundary
                key={selectedAgentId}
                agentId={selectedAgentId}
                active={visible && activeTab === "terminal"}
              />
            )}
          </TabsContent>
          {/* Both tabs stay mounted so refs (e.g. IntersectionObserver) remain attached */}
          <TabsContent
            forceMount
            value="inbox"
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
          </TabsContent>
          <TabsContent
            forceMount
            value="files"
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              activeTab !== "files" && "hidden"
            )}
          >
            <FilesContent
              files={files}
              ownFiles={ownFiles}
              subAgentFiles={subAgentFiles}
              filesState={filesState}
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
              active={visible && activeTab === "files"}
            />
          </TabsContent>
        </div>
      </Tabs>
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
    (width: number) =>
      clampDrawerWidth(width, viewportWidth, DRAWER_EDGE_GUTTER_PX),
    [viewportWidth]
  );
  const width = clamp(dragWidth ?? storedWidth ?? DRAWER_WIDTH_PX);
  return {
    width,
    min: DRAWER_MIN_WIDTH_PX,
    max: drawerMaxWidth(viewportWidth, DRAWER_EDGE_GUTTER_PX),
    viewportWidth,
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
      className="group absolute inset-y-0 left-0 z-sticky w-2 -translate-x-1/2 cursor-col-resize touch-none outline-none"
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
          "group-hover:bg-primary/veil group-focus-visible:bg-primary",
          drawerWidth.dragging && "bg-primary/veil"
        )}
      />
    </div>
  );
}

/**
 * The slot at the right edge, a Sheet. Pinned, it takes layout width (0 when
 * closed) and shrinks the centre; after the centre reaches its usable
 * reserve, further widening overlaps it, and it is a column that closes from
 * its button. Unpinned, it floats over the centre, and Escape or a press
 * outside closes it too. The sidebar and the thread drawer each sit in one,
 * so a thread takes the sidebar's place while it is open and gives it back
 * on close. Its left edge resizes it, and the width is one preference for
 * the client, shared by every frame.
 */
export function DrawerFrame({
  open,
  pinned,
  pinnedReserve = drawerPinnedReserve(true),
  onClose,
  dismissable = !pinned,
  testId = "drawer-wrapper",
  ...sheet
}: Pick<
  SheetProps,
  | "children"
  | "label"
  | "dialog"
  | "autoFocus"
  | "dismissable"
  | "keepOpen"
  | "onEscape"
  | "onOutsidePress"
> & {
  open: boolean;
  pinned: boolean;
  /**
   * What a pinned drawer leaves the rest of the row before an intentional
   * wider resize starts overlapping it.
   */
  pinnedReserve?: number;
  onClose: () => void;
  testId?: string;
}): JSX.Element {
  const drawerWidth = useDrawerWidth();
  const { width, viewportWidth, dragging } = drawerWidth;
  return (
    <Sheet
      {...sheet}
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      modal={false}
      docked={pinned}
      dismissable={dismissable}
      width={width}
      overlap={Math.max(
        0,
        width - drawerMaxWidth(viewportWidth, pinnedReserve)
      )}
      resizing={dragging}
      edge={open ? <DrawerResizeHandle drawerWidth={drawerWidth} /> : null}
      data-testid={testId}
    />
  );
}

export function Drawer({
  drawerOpen,
  setDrawerOpen,
  pinned,
  onTogglePin,
  pinnedReserve,
  ...props
}: DrawerProps): JSX.Element {
  return (
    <DrawerFrame
      open={drawerOpen}
      pinned={pinned}
      pinnedReserve={pinnedReserve}
      onClose={() => setDrawerOpen(false)}
    >
      <DrawerContent
        {...props}
        visible={drawerOpen}
        onRequestClose={() => setDrawerOpen(false)}
        pinned={pinned}
        onTogglePin={onTogglePin}
      />
    </DrawerFrame>
  );
}
