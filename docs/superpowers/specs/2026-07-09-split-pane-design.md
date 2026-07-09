# Split Pane for Terminal/Changes Area

## Overview

Add a split-pane feature to the center content area that lets users view two tabs side-by-side (e.g. Terminal + Changes) with a resizable divider. The feature is designed to support the current two tabs and a future third tab.

## Interaction Model

### Entering Split Mode

Users drag a tab from the `CenterPaneTabBar` to the left or right side of the content area.

1. Each tab in the tab bar is `draggable="true"` (HTML5 drag and drop).
2. When a drag starts, the content area shows two drop zones (left half, right half) with a subtle visual indicator — a semi-transparent overlay with a dashed border or background highlight.
3. Hovering over a zone highlights it to confirm the target.
4. On drop, the dragged tab renders in the dropped zone. The currently-active tab renders on the other side. The view enters split mode.
5. If already in split mode, dragging a tab onto an occupied zone replaces that pane's content.

Edge cases:

- Dragging the already-active tab onto its own current side: no-op.
- Only 1 tab available: drag is disabled.
- Dragging disabled on mobile.
- Clicking (not dragging) a tab in the center bar while in split mode: exits split mode and shows that tab full-width. Drag is the only gesture that enters or modifies a split.

### Exiting Split Mode (Unsplit)

A single button sits centered on the resizable divider between the two panes. The button uses a Lucide split-related icon (e.g. `SplitSquareHorizontal` or `Columns2`). Clicking it returns to single-pane mode, keeping the left pane's tab as the active tab.

### Resizing

The divider between panes is draggable to resize. Minimum pane width is ~20% to prevent collapsing too small.

## Layout

### Single-Pane Mode (Default)

No change from current behavior. The center tab bar shows all tabs, one is active, content fills full width.

### Split Mode

```
┌──────────────────────────────────────────────────┐
│  [◀] [*]        (remaining tabs)        [⚙] [▶] │  ← main header bar
├──────────────────────────────────────────────────┤
│ Terminal              │⊞│ Changes                │  ← pane headers + divider
│                       │ │                        │
│   (terminal content)  │ │   (changes content)    │
│                       │ │                        │
└───────────────────────┘ └────────────────────────┘
```

- Each pane gets a small header showing the tab name, styled to match existing tab text (`text-xs font-semibold uppercase tracking-wide`).
- The `ChangesSettingsPopover` moves into the Changes pane header when in split mode.
- The center tab bar shows only tabs NOT currently in a split pane. If all tabs are split, it hides or shows empty.
- The resizable divider uses `react-resizable-panels` handle styling — a thin vertical bar with the unsplit button centered on it.

## State Model

```ts
type CenterTab = "terminal" | "changes"; // extended later with 3rd tab

type SplitState = {
  mode: "single" | "split";
  left: CenterTab;
  right: CenterTab;
  sizes: [number, number]; // percentage for each pane, e.g. [50, 50]
};
```

Persisted per-agent using `atomFamily` keyed by agent ID, backed by `atomWithLocalStorage`. Key format: `dispatch:split-pane:<agentId>`.

## Implementation Approach

### Library

Add `react-resizable-panels` and the shadcn `Resizable` component (`ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle`). This is the standard shadcn pattern — accessible, keyboard-resizable, and provides `onLayout` callbacks for persistence.

### Routing

Currently tab switching is route-based (`/agents/:id` for terminal, `/agents/:id/changes` for changes).

In split mode, both tabs are visible simultaneously. The route points at whichever pane was most recently interacted with (for deep-linking and reload). Both panes render regardless of route match.

### Terminal Lifecycle

The terminal (`TerminalPane`) is currently hidden via `display:none` when on the changes tab but stays mounted. In split mode it is always visible — no lifecycle change needed. The xterm terminal needs a `fit` resize when pane widths change, triggered by the `onLayout` callback from `react-resizable-panels`.

### Changes Tab Lifecycle

Currently `ChangesTab` only mounts when the `/changes` route matches. In split mode it stays mounted regardless of route. Render condition becomes: route matches OR split state includes changes.

### Mobile

Split mode is disabled on mobile. If the user is in split mode on desktop and resizes to mobile, it falls back to single-pane showing the left pane's tab.

## Extensibility (3rd Tab)

The design supports N tabs with a 2-pane maximum:

- Add the new tab value to the `CenterTab` union.
- The tab bar shows all tabs not currently in a split pane.
- User can drag any tab into either split slot, replacing what's there.
- No 3-way split — maximum 2 panes at once.
- The 3rd tab lives in the tab bar and can be clicked (single-pane mode) or dragged (to replace a split pane's content).

## Components

| Component                 | Purpose                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| `ResizablePanel` (shadcn) | New UI component wrapping `react-resizable-panels`                          |
| `SplitPaneContainer`      | Orchestrates single vs split mode rendering, drop zones                     |
| `SplitPaneHeader`         | Small header bar for each pane in split mode (tab name + optional controls) |
| `CenterPaneTabBar`        | Modified — tabs become draggable, hides split tabs                          |
| `useSplitPane`            | Hook managing split state atom, enter/exit split, resize persistence        |

## Testing

- Unit tests for `useSplitPane` hook (state transitions, persistence, edge cases).
- E2E tests: drag tab to split, resize divider, click unsplit button, verify persistence across reload.
- Verify xterm terminal resizes correctly when split pane widths change.
- Verify mobile fallback behavior.
