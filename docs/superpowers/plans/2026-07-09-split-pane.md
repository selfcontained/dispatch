# Split Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag tabs to split the terminal/changes content area side-by-side with a resizable divider, and unsplit with a single button click.

**Architecture:** Add `react-resizable-panels` with a shadcn `Resizable` wrapper. A new `useSplitPane` hook manages persisted split state per agent via Jotai `atomFamily`. The `CenterPaneTabBar` gains drag support, and `agents-view.tsx` conditionally renders a `ResizablePanelGroup` in split mode or the current single-pane layout in normal mode.

**Tech Stack:** react-resizable-panels, Jotai atomFamily + atomWithLocalStorage, HTML5 Drag and Drop API, Lucide icons, Tailwind CSS

## Global Constraints

- Use `pnpm` for package management (not npm).
- Follow existing shadcn/ui component patterns in `apps/web/src/components/ui/`.
- Follow existing Jotai + atomWithLocalStorage patterns in `apps/web/src/lib/store.ts`.
- Follow existing test patterns: Vitest with jsdom for unit tests, Playwright for E2E.
- Split mode is desktop-only; disabled on mobile (`isMobile` prop).
- The `CenterTab` type union must be extensible for a future 3rd tab.
- All changes are in `apps/web/`.

---

### Task 1: Install react-resizable-panels and add shadcn Resizable component

**Files:**

- Modify: `apps/web/package.json` (add dependency)
- Create: `apps/web/src/components/ui/resizable.tsx` (shadcn component)

**Interfaces:**

- Produces: `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle` components exported from `@/components/ui/resizable`

- [ ] **Step 1: Install the dependency**

```bash
cd apps/web && pnpm add react-resizable-panels
```

- [ ] **Step 2: Create the shadcn Resizable component**

Create `apps/web/src/components/ui/resizable.tsx`:

```tsx
import { GripVertical } from "lucide-react";
import * as ResizablePrimitive from "react-resizable-panels";

import { cn } from "@/lib/utils";

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      className={cn(
        "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
        className
      )}
      {...props}
    />
  );
}

const ResizablePanel = ResizablePrimitive.Panel;

function ResizableHandle({
  withHandle,
  className,
  children,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      className={cn(
        "relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-[''] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:right-0 data-[panel-group-direction=vertical]:after:-top-1 data-[panel-group-direction=vertical]:after:-bottom-1 [&[data-resize-handle-state=drag]]:bg-ring [&[data-resize-handle-state=hover]]:bg-ring",
        className
      )}
      {...props}
    >
      {withHandle ? (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
          <GripVertical className="h-2.5 w-2.5" />
        </div>
      ) : null}
      {children}
    </ResizablePrimitive.PanelResizeHandle>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
```

- [ ] **Step 3: Verify the component compiles**

```bash
cd apps/web && pnpm run check
```

Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/package.json apps/web/src/components/ui/resizable.tsx pnpm-lock.yaml
git commit -m "feat: add react-resizable-panels and shadcn Resizable component"
```

---

### Task 2: Add split pane state atom and useSplitPane hook

**Files:**

- Modify: `apps/web/src/lib/store.ts` (add split pane atoms + types)
- Create: `apps/web/src/hooks/use-split-pane.ts` (hook)
- Modify: `apps/web/src/lib/store.test.ts` (add reconcile tests)

**Interfaces:**

- Consumes: `atomWithLocalStorage`, `atomFamily` from `apps/web/src/lib/store.ts`
- Produces:
  - Type `CenterTab = "terminal" | "changes"` (exported from store.ts)
  - Type `SplitPaneState = { mode: "single" | "split"; left: CenterTab; right: CenterTab; sizes: [number, number] }` (exported from store.ts)
  - `splitPaneStateAtomFamily(agentId: string)` returning `WritableAtom<SplitPaneState>` (exported from store.ts)
  - `SPLIT_PANE_STATE_STORAGE_PREFIX` constant (exported from store.ts)
  - `reconcileSplitPaneStateStorage(agentIds: Iterable<string>): void` (exported from store.ts)
  - `useSplitPane(agentId: string | null, isMobile: boolean)` hook returning `{ splitState, isSplit, enterSplit, exitSplit, updateSizes, handleTabDrop }` (exported from use-split-pane.ts)

- [ ] **Step 1: Write tests for reconcileSplitPaneStateStorage**

Add to `apps/web/src/lib/store.test.ts`:

```ts
import {
  // ... existing imports ...
  reconcileSplitPaneStateStorage,
  SPLIT_PANE_STATE_STORAGE_PREFIX,
} from "./store";

describe("reconcileSplitPaneStateStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  const storeForAgent = (agentId: string) => {
    window.localStorage.setItem(
      `${SPLIT_PANE_STATE_STORAGE_PREFIX}${agentId}`,
      JSON.stringify({
        mode: "single",
        left: "terminal",
        right: "changes",
        sizes: [50, 50],
      })
    );
  };

  it("removes keys for agents not in the live set", () => {
    storeForAgent("agt_1");
    storeForAgent("agt_2");
    storeForAgent("agt_3");

    reconcileSplitPaneStateStorage(["agt_1", "agt_3"]);

    expect(
      window.localStorage.getItem(`${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_1`)
    ).not.toBeNull();
    expect(
      window.localStorage.getItem(`${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_2`)
    ).toBeNull();
    expect(
      window.localStorage.getItem(`${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_3`)
    ).not.toBeNull();
  });

  it("handles empty live set gracefully", () => {
    storeForAgent("agt_1");
    reconcileSplitPaneStateStorage([]);
    expect(
      window.localStorage.getItem(`${SPLIT_PANE_STATE_STORAGE_PREFIX}agt_1`)
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/web && pnpm vitest run src/lib/store.test.ts
```

Expected: FAIL — `reconcileSplitPaneStateStorage` and `SPLIT_PANE_STATE_STORAGE_PREFIX` not found.

- [ ] **Step 3: Add split pane types, atoms, and reconcile function to store.ts**

Add to the end of `apps/web/src/lib/store.ts`:

```ts
// ---------------------------------------------------------------------------
// Split pane state — per-agent split/single mode and pane sizes
// ---------------------------------------------------------------------------

export type CenterTab = "terminal" | "changes";

export type SplitPaneState = {
  mode: "single" | "split";
  left: CenterTab;
  right: CenterTab;
  sizes: [number, number];
};

export const defaultSplitPaneState: SplitPaneState = {
  mode: "single",
  left: "terminal",
  right: "changes",
  sizes: [50, 50],
};

export const SPLIT_PANE_STATE_STORAGE_PREFIX = "dispatch:splitPane:";

export const splitPaneStateAtomFamily = atomFamily((agentId: string) =>
  atomWithLocalStorage<SplitPaneState>(
    `${SPLIT_PANE_STATE_STORAGE_PREFIX}${agentId}`,
    defaultSplitPaneState
  )
);

export function reconcileSplitPaneStateStorage(
  agentIds: Iterable<string>
): void {
  if (typeof window === "undefined") return;

  const liveAgentIds = new Set(agentIds);
  const keysToDelete: string[] = [];

  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key?.startsWith(SPLIT_PANE_STATE_STORAGE_PREFIX)) continue;

    const agentId = key.slice(SPLIT_PANE_STATE_STORAGE_PREFIX.length).trim();
    if (!agentId || liveAgentIds.has(agentId)) continue;
    keysToDelete.push(key);
  }

  keysToDelete.forEach((key) => window.localStorage.removeItem(key));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/web && pnpm vitest run src/lib/store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Create the useSplitPane hook**

Create `apps/web/src/hooks/use-split-pane.ts`:

```ts
import { useCallback, useMemo } from "react";
import { useAtom } from "jotai";

import {
  type CenterTab,
  type SplitPaneState,
  defaultSplitPaneState,
  splitPaneStateAtomFamily,
} from "@/lib/store";

const INACTIVE_ATOM = splitPaneStateAtomFamily("");

export function useSplitPane(agentId: string | null, isMobile: boolean) {
  const atom = agentId ? splitPaneStateAtomFamily(agentId) : INACTIVE_ATOM;
  const [rawState, setState] = useAtom(atom);

  const splitState: SplitPaneState =
    isMobile || !agentId ? defaultSplitPaneState : rawState;

  const isSplit = splitState.mode === "split" && !isMobile;

  const enterSplit = useCallback(
    (draggedTab: CenterTab, side: "left" | "right", activeTab: CenterTab) => {
      if (isMobile || !agentId) return;
      if (draggedTab === activeTab) return;

      const left = side === "left" ? draggedTab : activeTab;
      const right = side === "right" ? draggedTab : activeTab;

      setState({
        mode: "split",
        left,
        right,
        sizes: [50, 50],
      });
    },
    [agentId, isMobile, setState]
  );

  const exitSplit = useCallback(() => {
    setState((prev) => ({
      ...prev,
      mode: "single",
    }));
  }, [setState]);

  const updateSizes = useCallback(
    (sizes: number[]) => {
      if (sizes.length >= 2) {
        setState((prev) => ({
          ...prev,
          sizes: [sizes[0], sizes[1]] as [number, number],
        }));
      }
    },
    [setState]
  );

  const handleTabDrop = useCallback(
    (draggedTab: CenterTab, side: "left" | "right", activeTab: CenterTab) => {
      if (isMobile || !agentId) return;

      if (splitState.mode === "split") {
        setState((prev) => ({
          ...prev,
          [side]: draggedTab,
        }));
        return;
      }

      enterSplit(draggedTab, side, activeTab);
    },
    [agentId, enterSplit, isMobile, setState, splitState.mode]
  );

  return useMemo(
    () => ({
      splitState,
      isSplit,
      enterSplit,
      exitSplit,
      updateSizes,
      handleTabDrop,
    }),
    [splitState, isSplit, enterSplit, exitSplit, updateSizes, handleTabDrop]
  );
}
```

- [ ] **Step 6: Verify compilation**

```bash
cd apps/web && pnpm run check
```

Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/store.ts apps/web/src/lib/store.test.ts apps/web/src/hooks/use-split-pane.ts
git commit -m "feat: add split pane state atoms and useSplitPane hook"
```

---

### Task 3: Make CenterPaneTabBar tabs draggable with drop zones

**Files:**

- Modify: `apps/web/src/components/app/center-pane-tab-bar.tsx` (add drag behavior)
- Create: `apps/web/src/components/app/split-drop-zones.tsx` (drop target overlay)

**Interfaces:**

- Consumes: `CenterTab` type from `@/lib/store`
- Produces:
  - `CenterPaneTabBar` now accepts additional props: `isSplit: boolean`, `splitState: SplitPaneState` (to hide tabs currently in split panes)
  - `SplitDropZones` component accepting `{ visible: boolean; onDrop: (tab: string, side: "left" | "right") => void }`
  - Drag data transfer uses MIME type `application/x-dispatch-tab` with the tab id as the value

- [ ] **Step 1: Update CenterPaneTabBar to support draggable tabs and hide split tabs**

Modify `apps/web/src/components/app/center-pane-tab-bar.tsx`. Replace the full file content:

```tsx
import { memo, useCallback, useRef } from "react";

import type { DiffStats } from "@/components/app/types";
import { type CenterTab, type SplitPaneState } from "@/lib/store";
import { cn } from "@/lib/utils";

export const TAB_DRAG_MIME = "application/x-dispatch-tab";

type TabDef = {
  id: CenterTab;
  label: string;
};

const TABS: TabDef[] = [
  { id: "terminal", label: "Terminal" },
  { id: "changes", label: "Changes" },
];

type CenterPaneTabBarProps = {
  activeTab: CenterTab;
  onTabChange: (tab: CenterTab) => void;
  diffStats: DiffStats | null | undefined;
  isSplit: boolean;
  splitState: SplitPaneState;
  isMobile: boolean;
};

export const CenterPaneTabBar = memo(function CenterPaneTabBar({
  activeTab,
  onTabChange,
  diffStats,
  isSplit,
  splitState,
  isMobile,
}: CenterPaneTabBarProps): JSX.Element {
  const hasChanges =
    diffStats && (diffStats.added > 0 || diffStats.deleted > 0);

  const splitTabs = isSplit
    ? new Set<CenterTab>([splitState.left, splitState.right])
    : new Set<CenterTab>();

  const visibleTabs = TABS.filter((t) => !splitTabs.has(t.id));

  const handleDragStart = useCallback(
    (e: React.DragEvent, tabId: CenterTab) => {
      e.dataTransfer.setData(TAB_DRAG_MIME, tabId);
      e.dataTransfer.effectAllowed = "move";
    },
    []
  );

  if (visibleTabs.length === 0) return <div />;

  return (
    <div role="tablist" className="pointer-events-auto flex items-center">
      {visibleTabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          data-testid={`center-tab-${tab.id}`}
          draggable={!isMobile}
          onDragStart={(e) => handleDragStart(e, tab.id)}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors cursor-grab active:cursor-grabbing",
            activeTab === tab.id
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground/80"
          )}
          onClick={() => {
            if (isSplit) {
              // Clicking a tab in center bar while split exits split mode
              // and shows that tab full-width (per spec)
            }
            onTabChange(tab.id);
          }}
        >
          <span className="relative pb-1.5 -mb-1.5">
            {tab.label}
            {activeTab === tab.id && !isSplit ? (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-foreground" />
            ) : null}
          </span>
          {tab.id === "changes" && hasChanges ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-1.5 py-0 font-mono text-[10px] font-normal normal-case tracking-normal">
              <span className="text-status-working">+{diffStats.added}</span>
              <span className="text-status-blocked">-{diffStats.deleted}</span>
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
});
```

- [ ] **Step 2: Create the SplitDropZones component**

Create `apps/web/src/components/app/split-drop-zones.tsx`:

```tsx
import { memo, useCallback, useState } from "react";

import { TAB_DRAG_MIME } from "@/components/app/center-pane-tab-bar";
import { cn } from "@/lib/utils";

type SplitDropZonesProps = {
  visible: boolean;
  onDrop: (tab: string, side: "left" | "right") => void;
};

export const SplitDropZones = memo(function SplitDropZones({
  visible,
  onDrop,
}: SplitDropZonesProps): JSX.Element | null {
  const [activeSide, setActiveSide] = useState<"left" | "right" | null>(null);

  const handleDragOver = useCallback(
    (e: React.DragEvent, side: "left" | "right") => {
      if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setActiveSide(side);
    },
    []
  );

  const handleDragLeave = useCallback(() => {
    setActiveSide(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, side: "left" | "right") => {
      e.preventDefault();
      setActiveSide(null);
      const tabId = e.dataTransfer.getData(TAB_DRAG_MIME);
      if (tabId) {
        onDrop(tabId, side);
      }
    },
    [onDrop]
  );

  if (!visible) return null;

  return (
    <div className="absolute inset-0 z-30 flex" data-testid="split-drop-zones">
      <div
        className={cn(
          "flex-1 flex items-center justify-center border-2 border-dashed rounded-l-lg m-2 mr-1 transition-colors",
          activeSide === "left"
            ? "border-ring bg-ring/10"
            : "border-muted-foreground/30 bg-muted/10"
        )}
        onDragOver={(e) => handleDragOver(e, "left")}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleDrop(e, "left")}
        data-testid="split-drop-left"
      >
        <span
          className={cn(
            "text-sm font-medium uppercase tracking-wide transition-colors",
            activeSide === "left"
              ? "text-foreground"
              : "text-muted-foreground/60"
          )}
        >
          Left
        </span>
      </div>
      <div
        className={cn(
          "flex-1 flex items-center justify-center border-2 border-dashed rounded-r-lg m-2 ml-1 transition-colors",
          activeSide === "right"
            ? "border-ring bg-ring/10"
            : "border-muted-foreground/30 bg-muted/10"
        )}
        onDragOver={(e) => handleDragOver(e, "right")}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleDrop(e, "right")}
        data-testid="split-drop-right"
      >
        <span
          className={cn(
            "text-sm font-medium uppercase tracking-wide transition-colors",
            activeSide === "right"
              ? "text-foreground"
              : "text-muted-foreground/60"
          )}
        >
          Right
        </span>
      </div>
    </div>
  );
});
```

- [ ] **Step 3: Verify compilation**

```bash
cd apps/web && pnpm run check
```

Expected: Type errors in `agents-view.tsx` because `CenterPaneTabBar` now requires new props. That's expected — Task 4 will fix it.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/app/center-pane-tab-bar.tsx apps/web/src/components/app/split-drop-zones.tsx
git commit -m "feat: make tab bar tabs draggable and add split drop zones"
```

---

### Task 4: Integrate split pane into agents-view.tsx

This is the main integration task. Wire up the `useSplitPane` hook, render the `ResizablePanelGroup` in split mode, show drop zones during drag, and add the unsplit button on the resize handle.

**Files:**

- Modify: `apps/web/src/components/app/agents-view.tsx` (integrate split pane rendering)
- Modify: `apps/web/src/hooks/use-agents-view-routing.ts` (export `onTabChange` that also exits split)

**Interfaces:**

- Consumes: `useSplitPane` hook, `SplitDropZones`, `ResizablePanelGroup`/`ResizablePanel`/`ResizableHandle`, `CenterPaneTabBar` with new props, `CenterTab` and `SplitPaneState` types, `TAB_DRAG_MIME` constant
- Produces: Full split pane rendering in `agents-view.tsx`

- [ ] **Step 1: Add drag state tracking and useSplitPane to agents-view.tsx**

At the top of `agents-view.tsx`, add the new imports:

```ts
import { Columns2 } from "lucide-react";

import { SplitDropZones } from "@/components/app/split-drop-zones";
import { TAB_DRAG_MIME } from "@/components/app/center-pane-tab-bar";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useSplitPane } from "@/hooks/use-split-pane";
import { type CenterTab } from "@/lib/store";
```

Inside the `AgentsView` function body, after the existing `useAgentsViewRouting` call, add:

```ts
const { splitState, isSplit, exitSplit, updateSizes, handleTabDrop } =
  useSplitPane(focusedAgentId, isMobile);

const [isDraggingTab, setIsDraggingTab] = useState(false);

const handleContentDragOver = useCallback((e: React.DragEvent) => {
  if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
  setIsDraggingTab(true);
}, []);

const handleContentDragLeave = useCallback((e: React.DragEvent) => {
  if (e.currentTarget.contains(e.relatedTarget as Node)) return;
  setIsDraggingTab(false);
}, []);

const handleContentDrop = useCallback(() => {
  setIsDraggingTab(false);
}, []);

const handleDropSide = useCallback(
  (side: "left" | "right") => {
    const dragEvent = window.__dispatchDragTab as CenterTab | undefined;
    if (dragEvent) {
      const activeTab: CenterTab = changesMatch ? "changes" : "terminal";
      handleTabDrop(dragEvent, side, activeTab);
    }
    setIsDraggingTab(false);
  },
  [changesMatch, handleTabDrop]
);
```

In `agents-view.tsx`, the drop handler:

```ts
const handleDropOnZone = useCallback(
  (tab: string, side: "left" | "right") => {
    const activeTab: CenterTab = changesMatch ? "changes" : "terminal";
    handleTabDrop(tab as CenterTab, side, activeTab);
    setIsDraggingTab(false);
  },
  [changesMatch, handleTabDrop]
);
```

- [ ] **Step 2: Update the CenterPaneTabBar invocation**

Replace the existing `<CenterPaneTabBar>` JSX in agents-view.tsx (around line 527-531) with:

```tsx
<CenterPaneTabBar
  activeTab={changesMatch ? "changes" : "terminal"}
  onTabChange={(tab) => {
    if (isSplit) {
      exitSplit();
    }
    onTabChange(tab);
  }}
  diffStats={focusedDiffStats}
  isSplit={isSplit}
  splitState={splitState}
  isMobile={isMobile}
/>
```

- [ ] **Step 3: Replace the content area with split-aware rendering**

Replace the content div (the one containing `TerminalPane` and the `<Routes>` block, around lines 563-601) with:

```tsx
<div
  className={cn("relative min-h-0 flex-1", !isMobile && "pb-14")}
  onDragOver={handleContentDragOver}
  onDragLeave={handleContentDragLeave}
  onDrop={handleContentDrop}
>
  {isSplit ? (
    <ResizablePanelGroup
      direction="horizontal"
      onLayout={updateSizes}
      className="h-full"
    >
      <ResizablePanel defaultSize={splitState.sizes[0]} minSize={20}>
        <div className="flex h-full flex-col">
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-border/40 px-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {splitState.left === "terminal" ? "Terminal" : "Changes"}
            </span>
          </div>
          <div className="min-h-0 flex-1">
            {splitState.left === "terminal" ? (
              <TerminalPane
                isAttached={isAttached}
                connState={connState}
                statusMessage={statusMessage}
                terminalMode={terminalMode}
                terminalPlaceholderMessage={terminalPlaceholderMessage}
                terminalHostRef={terminalHostRef}
                resyncing={resyncing}
                draggingFiles={draggingFiles}
                uploadingFiles={uploadingFiles}
                archivePhase={
                  selectedAgent?.status === "archiving"
                    ? selectedAgent.archivePhase
                    : null
                }
              />
            ) : (
              <ChangesTab
                agentId={focusedAgentId}
                active={true}
                isMobile={isMobile}
              />
            )}
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle>
        <button
          type="button"
          onClick={exitSplit}
          title="Unsplit panes"
          data-testid="unsplit-button"
          className="z-10 flex h-6 w-6 items-center justify-center rounded-sm border bg-background text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <Columns2 className="h-3.5 w-3.5" />
        </button>
      </ResizableHandle>
      <ResizablePanel defaultSize={splitState.sizes[1]} minSize={20}>
        <div className="flex h-full flex-col">
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-border/40 px-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {splitState.right === "terminal" ? "Terminal" : "Changes"}
            </span>
            {splitState.right === "changes" && !isMobile ? (
              <ChangesSettingsPopover />
            ) : null}
            {splitState.left === "changes" ? null : null}
          </div>
          <div className="min-h-0 flex-1">
            {splitState.right === "terminal" ? (
              <TerminalPane
                isAttached={isAttached}
                connState={connState}
                statusMessage={statusMessage}
                terminalMode={terminalMode}
                terminalPlaceholderMessage={terminalPlaceholderMessage}
                terminalHostRef={terminalHostRef}
                resyncing={resyncing}
                draggingFiles={draggingFiles}
                uploadingFiles={uploadingFiles}
                archivePhase={
                  selectedAgent?.status === "archiving"
                    ? selectedAgent.archivePhase
                    : null
                }
              />
            ) : (
              <ChangesTab
                agentId={focusedAgentId}
                active={true}
                isMobile={isMobile}
              />
            )}
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  ) : (
    <>
      <div className={cn("h-full", changesMatch && "hidden")}>
        <TerminalPane
          isAttached={isAttached}
          connState={connState}
          statusMessage={statusMessage}
          terminalMode={terminalMode}
          terminalPlaceholderMessage={terminalPlaceholderMessage}
          terminalHostRef={terminalHostRef}
          resyncing={resyncing}
          draggingFiles={draggingFiles}
          uploadingFiles={uploadingFiles}
          archivePhase={
            selectedAgent?.status === "archiving"
              ? selectedAgent.archivePhase
              : null
          }
        />
      </div>
      <Routes>
        <Route
          path="changes"
          element={
            <ChangesTab
              agentId={focusedAgentId}
              active={true}
              isMobile={isMobile}
            />
          }
        />
      </Routes>
    </>
  )}
  <SplitDropZones
    visible={isDraggingTab && !isMobile}
    onDrop={handleDropOnZone}
  />
  {!isMobile ? (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-14 bg-background">
      <AmbientTipBar />
    </div>
  ) : null}
</div>
```

- [ ] **Step 4: Move ChangesSettingsPopover into the pane header in split mode**

In the existing header bar area (around line 536), update the `ChangesSettingsPopover` condition to only show in single-pane mode (it moves to the split pane header in split mode):

```tsx
{
  changesMatch && !isMobile && !isSplit ? <ChangesSettingsPopover /> : null;
}
```

Also add `ChangesSettingsPopover` in the left pane header when the left pane shows changes:

In the left pane's header div, after the tab label span, add:

```tsx
{
  splitState.left === "changes" && !isMobile ? (
    <ChangesSettingsPopover />
  ) : null;
}
```

- [ ] **Step 5: Wire up storage reconciliation**

In `apps/web/src/hooks/use-media-sidebar-state.ts`, at line 8-9 add the import:

```ts
import {
  reconcileMediaSidebarStateStorage,
  reconcileDiffViewStateStorage,
  reconcileSplitPaneStateStorage,
} from "@/lib/store";
```

At lines 97-98 (inside the `useEffect` that calls the other reconcile functions), add:

```ts
reconcileSplitPaneStateStorage(agentIds as string[]);
```

- [ ] **Step 6: Verify compilation**

```bash
cd apps/web && pnpm run check
```

Expected: No type errors.

- [ ] **Step 7: Run the full test suite**

```bash
pnpm run finalize:web
```

Expected: Type check + build pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/app/agents-view.tsx apps/web/src/components/app/split-drop-zones.tsx apps/web/src/hooks/use-split-pane.ts apps/web/src/components/app/center-pane-tab-bar.tsx
git add -u
git commit -m "feat: integrate split pane rendering into agents view"
```

---

### Task 5: Handle terminal resize on split pane layout changes

When pane widths change in split mode, the xterm terminal needs to re-fit. The `useTerminal` hook already handles resize via a combination of `ResizeObserver` and the xterm `FitAddon`. However, the `react-resizable-panels` layout changes trigger DOM size changes that the `ResizeObserver` should pick up automatically. If it doesn't, we need to trigger a fit manually.

**Files:**

- Modify: `apps/web/src/hooks/use-terminal.ts` (verify or add resize handling)
- Modify: `apps/web/src/components/app/agents-view.tsx` (pass split state to useTerminal if needed)

**Interfaces:**

- Consumes: `useSplitPane`'s `isSplit` flag, `updateSizes` callback from `onLayout`
- Produces: Terminal correctly resizes when split pane divider is dragged

- [ ] **Step 1: Check how useTerminal handles resize**

Read `apps/web/src/hooks/use-terminal.ts` and find the resize/fit logic. Look for `ResizeObserver` or `FitAddon` usage.

- [ ] **Step 2: Verify the existing ResizeObserver handles the resize**

The `react-resizable-panels` library changes the actual DOM width of the panel containers, which should trigger any `ResizeObserver` watching the terminal host element. Start the dev server, enter split mode, and drag the divider. If the terminal re-fits automatically, no additional work is needed.

If the terminal does NOT re-fit automatically (the `ResizeObserver` isn't watching the right element, or it debounces too aggressively), add a `splitResizeKey` dependency:

In `agents-view.tsx`, pass `splitSizes` to `useTerminal` as part of its existing `mediaResizeSettleKey` mechanism, or add a new prop. The `useTerminal` hook accepts `deferMediaResize` / `mediaResizeSettleKey` for a similar purpose — piggyback on that or add `splitLayoutKey: isSplit ? splitState.sizes.join(",") : ""`.

- [ ] **Step 3: Test resize behavior manually**

Start dev server via `repo_dev_up`. Enter split mode with Terminal on one side. Drag the divider. Verify the terminal text re-flows correctly.

- [ ] **Step 4: Commit if changes were needed**

```bash
git add -u
git commit -m "fix: ensure terminal re-fits when split pane is resized"
```

---

### Task 6: E2E tests for split pane

**Files:**

- Create: `e2e/split-pane.spec.ts`

**Interfaces:**

- Consumes: `createAgentViaAPI`, `cleanupE2EAgents` from `e2e/helpers.ts`
- Produces: E2E coverage for split mode entry, unsplit, persistence, and mobile behavior

- [ ] **Step 1: Create the E2E test file**

Create `e2e/split-pane.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { cleanupE2EAgents, createAgentViaAPI } from "./helpers";

async function waitForAppShell(
  page: import("@playwright/test").Page,
  agentName: string
): Promise<void> {
  await page.getByTestId("agent-sidebar").waitFor({ state: "visible" });
  await page.getByTestId("terminal-pane").waitFor({ state: "visible" });
  await page
    .getByTestId("agent-sidebar")
    .getByText(agentName)
    .first()
    .waitFor({ state: "visible" });
}

test.describe("Split pane", () => {
  test.afterEach(async ({ request }) => {
    await cleanupE2EAgents(request);
  });

  test("drag tab to split and unsplit via button", async ({
    page,
    request,
  }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-split-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    const changesTab = page.getByTestId("center-tab-changes");
    await expect(changesTab).toBeVisible();

    // Drag the Changes tab to the right side
    const contentArea = page.getByTestId("terminal-pane").locator("..");
    const box = await contentArea.boundingBox();
    expect(box).not.toBeNull();

    await changesTab.dragTo(contentArea, {
      targetPosition: { x: box!.width * 0.75, y: box!.height / 2 },
    });

    // Should see the unsplit button
    const unsplitBtn = page.getByTestId("unsplit-button");
    await expect(unsplitBtn).toBeVisible({ timeout: 3000 });

    // Click unsplit
    await unsplitBtn.click();
    await expect(unsplitBtn).not.toBeVisible();

    // Tab bar should be restored
    await expect(page.getByTestId("center-tab-terminal")).toBeVisible();
    await expect(page.getByTestId("center-tab-changes")).toBeVisible();
  });

  test("split state persists across page reload", async ({ page, request }) => {
    const agent = await createAgentViaAPI(request, {
      name: `e2e-split-persist-${Date.now()}`,
    });

    await page.goto(`/agents/${agent.id}`, { waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    // Enter split mode via localStorage injection (simpler than drag in CI)
    await page.evaluate((agentId) => {
      window.localStorage.setItem(
        `dispatch:splitPane:${agentId}`,
        JSON.stringify({
          mode: "split",
          left: "terminal",
          right: "changes",
          sizes: [50, 50],
        })
      );
    }, agent.id);

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAppShell(page, agent.name);

    // Should be in split mode after reload
    const unsplitBtn = page.getByTestId("unsplit-button");
    await expect(unsplitBtn).toBeVisible({ timeout: 5000 });
  });
});
```

- [ ] **Step 2: Run the E2E tests**

```bash
pnpm run test:e2e -- --grep "Split pane"
```

Expected: Tests pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/split-pane.spec.ts
git commit -m "test: add E2E tests for split pane feature"
```

---

### Task 7: Final validation and cleanup

**Files:**

- Possibly modify any files from Tasks 1-6 that need polish.

**Interfaces:**

- Consumes: All prior tasks
- Produces: All checks pass, feature works end-to-end

- [ ] **Step 1: Run type checking**

```bash
pnpm run check
```

Expected: No type errors.

- [ ] **Step 2: Run web finalization**

```bash
pnpm run finalize:web
```

Expected: Type check + production build pass.

- [ ] **Step 3: Run unit tests**

```bash
cd apps/web && pnpm vitest run
```

Expected: All tests pass.

- [ ] **Step 4: Run E2E tests**

```bash
pnpm run test:e2e
```

Expected: All tests pass (including the new split-pane tests).

- [ ] **Step 5: Visual validation via Playwright**

Start the dev server with `repo_dev_up`. Use Playwright to:

1. Navigate to an agent
2. Verify the tab bar shows Terminal and Changes
3. Enter split mode (inject localStorage state)
4. Verify both panes render
5. Click unsplit button
6. Verify single pane mode restores
7. Capture screenshots and share via `dispatch_share`

- [ ] **Step 6: Clean up and commit any remaining fixes**

```bash
git add -u
git commit -m "chore: split pane final cleanup and polish"
```
