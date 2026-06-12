# Guided Tips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a feature discovery system with two surfaces — inline popovers on new features and an ambient tip bar — backed by a shared tip registry and Jotai state.

**Architecture:** A unified tip registry (`tips.ts`) defines all tips. Jotai atoms (`atomWithLocalStorage`) track dismissal state and the user's last-seen version. Two independent UI surfaces consume this shared state: `TipSpot` (a wrapper component that renders a Radix Popover anchored to its child) and `AmbientTipBar` (an idle-triggered bottom bar). A `TipQueueProvider` context coordinates inline popovers so only one shows at a time.

**Tech Stack:** React, Jotai, Radix UI Popover, Tailwind CSS, Vitest

**Spec:** `docs/superpowers/specs/2026-06-11-guided-tips-design.md`

---

## File Map

| File                                                    | Responsibility                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/web/src/lib/tips/tips.ts`                         | Tip definitions array and `Tip` type                                       |
| `apps/web/src/lib/tips/tips-state.ts`                   | Jotai atoms: `tipsEnabledAtom`, `dismissedTipsAtom`, `lastSeenVersionAtom` |
| `apps/web/src/lib/tips/use-tip.ts`                      | `useTip(id)` hook — reads registry + state, returns visibility and actions |
| `apps/web/src/lib/tips/version-compare.ts`              | Simple semver comparison (`isVersionNewer`)                                |
| `apps/web/src/components/tips/tip-popover-content.tsx`  | Popover body: title, description, learn more, dismiss, don't show          |
| `apps/web/src/components/tips/tip-spot.tsx`             | `<TipSpot>` wrapper — renders Radix Popover around its child               |
| `apps/web/src/components/tips/tip-queue-provider.tsx`   | Context provider: ensures one inline popover at a time                     |
| `apps/web/src/components/tips/ambient-tip-bar.tsx`      | Bottom bar: idle detection, random roll, auto-hide timer, hover pause      |
| `apps/web/src/lib/store.ts`                             | Modified — export new tip atoms                                            |
| `apps/web/src/App.tsx`                                  | Modified — wrap layout in `TipQueueProvider`                               |
| `apps/web/src/components/app/agents-view.tsx`           | Modified — add `AmbientTipBar` in bottom buffer area                       |
| `apps/web/src/components/app/notification-settings.tsx` | Modified — add Tips section with toggle and reset button                   |

---

### Task 1: Version Comparison Utility

**Files:**

- Create: `apps/web/src/lib/tips/version-compare.ts`
- Test: `apps/web/src/lib/tips/__tests__/version-compare.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/lib/tips/__tests__/version-compare.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { isVersionNewer } from "../version-compare";

describe("isVersionNewer", () => {
  it("returns true when version is newer (patch)", () => {
    expect(isVersionNewer("0.23.1", "0.23.0")).toBe(true);
  });

  it("returns true when version is newer (minor)", () => {
    expect(isVersionNewer("0.24.0", "0.23.5")).toBe(true);
  });

  it("returns true when version is newer (major)", () => {
    expect(isVersionNewer("1.0.0", "0.99.99")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(isVersionNewer("0.23.0", "0.23.0")).toBe(false);
  });

  it("returns false when version is older", () => {
    expect(isVersionNewer("0.22.0", "0.23.0")).toBe(false);
  });

  it("handles versions with v prefix", () => {
    expect(isVersionNewer("v0.24.0", "v0.23.0")).toBe(true);
  });

  it("returns false for equal versions with v prefix", () => {
    expect(isVersionNewer("v0.23.0", "0.23.0")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web/src/lib/tips/__tests__/version-compare.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `apps/web/src/lib/tips/version-compare.ts`:

```ts
function parseVersion(v: string): [number, number, number] {
  const cleaned = v.startsWith("v") ? v.slice(1) : v;
  const parts = cleaned.split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function isVersionNewer(a: string, b: string): boolean {
  const [aMajor, aMinor, aPatch] = parseVersion(a);
  const [bMajor, bMinor, bPatch] = parseVersion(b);
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch > bPatch;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/web/src/lib/tips/__tests__/version-compare.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/tips/version-compare.ts apps/web/src/lib/tips/__tests__/version-compare.test.ts
git commit -m "feat(tips): add semver comparison utility"
```

---

### Task 2: Tip Registry

**Files:**

- Create: `apps/web/src/lib/tips/tips.ts`
- Test: `apps/web/src/lib/tips/__tests__/tips.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/tips/__tests__/tips.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { type Surface, type Tip, tips } from "../tips";

describe("tips registry", () => {
  it("exports a non-empty array of tips", () => {
    expect(tips.length).toBeGreaterThan(0);
  });

  it("has unique IDs", () => {
    const ids = tips.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every tip has required fields", () => {
    for (const tip of tips) {
      expect(tip.id).toBeTruthy();
      expect(tip.title).toBeTruthy();
      expect(tip.body).toBeTruthy();
      expect(tip.since).toMatch(/^\d+\.\d+\.\d+$/);
      expect(tip.surfaces.length).toBeGreaterThan(0);
      for (const s of tip.surfaces) {
        expect(["inline", "ambient"]).toContain(s);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web/src/lib/tips/__tests__/tips.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `apps/web/src/lib/tips/tips.ts`:

```ts
export type Surface = "inline" | "ambient";

export type Tip = {
  id: string;
  title: string;
  body: string;
  docsSection?: string;
  since: string;
  surfaces: Surface[];
};

export const tips: Tip[] = [
  {
    id: "quick-phrases",
    title: "Quick Phrases",
    body: "Inject saved phrases into your terminal session with one click. Create reusable snippets for common commands.",
    docsSection: "shortcuts",
    since: "0.23.0",
    surfaces: ["inline", "ambient"],
  },
  {
    id: "personas",
    title: "Personas",
    body: "Launch specialized review agents with structured feedback. Define reusable roles for security, UX, or code review.",
    docsSection: "personas",
    since: "0.22.0",
    surfaces: ["inline", "ambient"],
  },
  {
    id: "brain",
    title: "Brain",
    body: "Repo-scoped shared memory that persists across agent sessions. Store objects, lists, and event logs your agents can access.",
    docsSection: "events",
    since: "0.20.0",
    surfaces: ["inline", "ambient"],
  },
  {
    id: "automations",
    title: "Automations",
    body: "Schedule recurring jobs like PR triage, dependency checks, or custom workflows on a cron schedule.",
    docsSection: "automations",
    since: "0.18.0",
    surfaces: ["inline", "ambient"],
  },
  {
    id: "media-sidebar",
    title: "Media Sidebar",
    body: "View agent pins, screenshots, and shared media in a collapsible sidebar. Pin it to keep it visible while you work.",
    docsSection: "media",
    since: "0.19.0",
    surfaces: ["inline", "ambient"],
  },
];

export function getTipById(id: string): Tip | undefined {
  return tips.find((t) => t.id === id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/web/src/lib/tips/__tests__/tips.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/tips/tips.ts apps/web/src/lib/tips/__tests__/tips.test.ts
git commit -m "feat(tips): add tip registry with starter tips"
```

---

### Task 3: Tips State Atoms

**Files:**

- Create: `apps/web/src/lib/tips/tips-state.ts`
- Test: `apps/web/src/lib/tips/__tests__/tips-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/tips/__tests__/tips-state.test.ts`:

```ts
import { createStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";

import {
  dismissedTipsAtom,
  lastSeenVersionAtom,
  tipsEnabledAtom,
} from "../tips-state";

describe("tips state atoms", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    window.localStorage.clear();
    store = createStore();
  });

  it("tipsEnabledAtom defaults to true", () => {
    expect(store.get(tipsEnabledAtom)).toBe(true);
  });

  it("dismissedTipsAtom defaults to empty array", () => {
    expect(store.get(dismissedTipsAtom)).toEqual([]);
  });

  it("lastSeenVersionAtom defaults to null", () => {
    expect(store.get(lastSeenVersionAtom)).toBeNull();
  });

  it("tipsEnabledAtom persists to localStorage", () => {
    store.set(tipsEnabledAtom, false);
    expect(JSON.parse(localStorage.getItem("dispatch:tipsEnabled")!)).toBe(
      false
    );
  });

  it("dismissedTipsAtom persists to localStorage", () => {
    store.set(dismissedTipsAtom, ["quick-phrases", "personas"]);
    expect(JSON.parse(localStorage.getItem("dispatch:dismissedTips")!)).toEqual(
      ["quick-phrases", "personas"]
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web/src/lib/tips/__tests__/tips-state.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `apps/web/src/lib/tips/tips-state.ts`:

```ts
import { atomWithLocalStorage } from "../store";

export const tipsEnabledAtom = atomWithLocalStorage(
  "dispatch:tipsEnabled",
  true
);

export const dismissedTipsAtom = atomWithLocalStorage<string[]>(
  "dispatch:dismissedTips",
  []
);

export const lastSeenVersionAtom = atomWithLocalStorage<string | null>(
  "dispatch:lastSeenVersion",
  null
);
```

**Important:** `atomWithLocalStorage` is currently not exported from `apps/web/src/lib/store.ts`. Add the export:

In `apps/web/src/lib/store.ts`, change the function declaration from:

```ts
function atomWithLocalStorage<T>(key: string, initialValue: T) {
```

to:

```ts
export function atomWithLocalStorage<T>(key: string, initialValue: T) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/web/src/lib/tips/__tests__/tips-state.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/tips/tips-state.ts apps/web/src/lib/tips/__tests__/tips-state.test.ts apps/web/src/lib/store.ts
git commit -m "feat(tips): add Jotai atoms for tips state"
```

---

### Task 4: useTip Hook

**Files:**

- Create: `apps/web/src/lib/tips/use-tip.ts`
- Test: `apps/web/src/lib/tips/__tests__/use-tip.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/tips/__tests__/use-tip.test.ts`:

```ts
import { createStore, Provider } from "jotai";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  dismissedTipsAtom,
  lastSeenVersionAtom,
  tipsEnabledAtom,
} from "../tips-state";
import { useTip } from "../use-tip";

vi.mock("@/lib/version", () => ({ BUILD_VERSION: "0.23.0" }));

function renderUseTip(
  id: string,
  store: ReturnType<typeof createStore>
) {
  return renderHook(() => useTip(id), {
    wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
  });
}

describe("useTip", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    window.localStorage.clear();
    store = createStore();
  });

  it("returns null tip for unknown ID", () => {
    const { result } = renderUseTip("nonexistent", store);
    expect(result.current.tip).toBeNull();
    expect(result.current.shouldShowInline).toBe(false);
    expect(result.current.shouldShowAmbient).toBe(false);
  });

  it("shouldShowInline is true when tip version is newer than lastSeenVersion", () => {
    store.set(lastSeenVersionAtom, "0.21.0");
    const { result } = renderUseTip("personas", store); // since: "0.22.0"
    expect(result.current.shouldShowInline).toBe(true);
  });

  it("shouldShowInline is false when tip version is older than lastSeenVersion", () => {
    store.set(lastSeenVersionAtom, "0.23.0");
    const { result } = renderUseTip("personas", store); // since: "0.22.0"
    expect(result.current.shouldShowInline).toBe(false);
  });

  it("shouldShowInline is false when lastSeenVersion is null (first-time user)", () => {
    const { result } = renderUseTip("personas", store);
    expect(result.current.shouldShowInline).toBe(false);
  });

  it("shouldShowAmbient is true for undismissed tips regardless of version", () => {
    store.set(lastSeenVersionAtom, "0.23.0");
    const { result } = renderUseTip("personas", store); // since: "0.22.0"
    expect(result.current.shouldShowAmbient).toBe(true);
  });

  it("shouldShowAmbient is false when tips are disabled", () => {
    store.set(tipsEnabledAtom, false);
    const { result } = renderUseTip("personas", store);
    expect(result.current.shouldShowAmbient).toBe(false);
  });

  it("dismiss marks the tip as dismissed", () => {
    store.set(lastSeenVersionAtom, "0.21.0");
    const { result } = renderUseTip("personas", store);
    expect(result.current.shouldShowAmbient).toBe(true);

    act(() => result.current.dismiss());

    expect(result.current.shouldShowAmbient).toBe(false);
    expect(result.current.shouldShowInline).toBe(false);
    expect(store.get(dismissedTipsAtom)).toContain("personas");
  });

  it("disableAll sets tipsEnabled to false", () => {
    const { result } = renderUseTip("personas", store);
    act(() => result.current.disableAll());
    expect(store.get(tipsEnabledAtom)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/web/src/lib/tips/__tests__/use-tip.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `apps/web/src/lib/tips/use-tip.ts`:

```ts
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";

import { BUILD_VERSION } from "@/lib/version";

import { getTipById } from "./tips";
import {
  dismissedTipsAtom,
  lastSeenVersionAtom,
  tipsEnabledAtom,
} from "./tips-state";
import { isVersionNewer } from "./version-compare";

export function useTip(id: string) {
  const tip = useMemo(() => getTipById(id) ?? null, [id]);
  const enabled = useAtomValue(tipsEnabledAtom);
  const [dismissed, setDismissed] = useAtom(dismissedTipsAtom);
  const setEnabled = useSetAtom(tipsEnabledAtom);
  const lastSeenVersion = useAtomValue(lastSeenVersionAtom);

  const isDismissed = dismissed.includes(id);

  const shouldShowInline =
    tip !== null &&
    enabled &&
    !isDismissed &&
    tip.surfaces.includes("inline") &&
    lastSeenVersion !== null &&
    isVersionNewer(tip.since, lastSeenVersion) &&
    !isVersionNewer(tip.since, BUILD_VERSION);

  const shouldShowAmbient =
    tip !== null && enabled && !isDismissed && tip.surfaces.includes("ambient");

  const dismiss = useCallback(() => {
    setDismissed((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, [id, setDismissed]);

  const disableAll = useCallback(() => {
    setEnabled(false);
  }, [setEnabled]);

  return { tip, shouldShowInline, shouldShowAmbient, dismiss, disableAll };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/web/src/lib/tips/__tests__/use-tip.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/tips/use-tip.ts apps/web/src/lib/tips/__tests__/use-tip.test.ts
git commit -m "feat(tips): add useTip hook with version gating"
```

---

### Task 5: TipQueueProvider

**Files:**

- Create: `apps/web/src/components/tips/tip-queue-provider.tsx`

- [ ] **Step 1: Write the provider**

Create `apps/web/src/components/tips/tip-queue-provider.tsx`:

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

type TipQueueContextValue = {
  activeTipId: string | null;
  requestOpen: (tipId: string) => boolean;
  release: (tipId: string) => void;
};

const TipQueueContext = createContext<TipQueueContextValue>({
  activeTipId: null,
  requestOpen: () => false,
  release: () => {},
});

export function useTipQueue() {
  return useContext(TipQueueContext);
}

export function TipQueueProvider({ children }: { children: React.ReactNode }) {
  const [activeTipId, setActiveTipId] = useState<string | null>(null);
  const queueRef = useRef<string[]>([]);

  const requestOpen = useCallback(
    (tipId: string): boolean => {
      if (activeTipId === null) {
        setActiveTipId(tipId);
        return true;
      }
      if (activeTipId === tipId) return true;
      if (!queueRef.current.includes(tipId)) {
        queueRef.current.push(tipId);
      }
      return false;
    },
    [activeTipId]
  );

  const release = useCallback((tipId: string) => {
    setActiveTipId((current) => {
      if (current !== tipId) return current;
      const next = queueRef.current.shift() ?? null;
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ activeTipId, requestOpen, release }),
    [activeTipId, requestOpen, release]
  );

  return (
    <TipQueueContext.Provider value={value}>
      {children}
    </TipQueueContext.Provider>
  );
}
```

- [ ] **Step 2: Wire into App.tsx**

In `apps/web/src/App.tsx`, import the provider:

```ts
import { TipQueueProvider } from "@/components/tips/tip-queue-provider";
```

Wrap the return value in `DashboardLayout` (around line 242):

```tsx
return (
  <TipQueueProvider>
    <Outlet context={context} />
    <ReleaseAvailableToast />
    <UpdateAvailableToast />
    <Toaster
      position="bottom-right"
      closeButton
      richColors
      toastOptions={{ duration: 3000 }}
    />
  </TipQueueProvider>
);
```

- [ ] **Step 3: Run type check**

Run: `pnpm run check`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/tips/tip-queue-provider.tsx apps/web/src/App.tsx
git commit -m "feat(tips): add TipQueueProvider for single-popover coordination"
```

---

### Task 6: TipPopoverContent Component

**Files:**

- Create: `apps/web/src/components/tips/tip-popover-content.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/tips/tip-popover-content.tsx`:

```tsx
import { Sparkles, X } from "lucide-react";

import type { Tip } from "@/lib/tips/tips";

type TipPopoverContentProps = {
  tip: Tip;
  onDismiss: () => void;
  onDisableAll: () => void;
  onOpenDocs?: (section: string) => void;
};

export function TipPopoverContent({
  tip,
  onDismiss,
  onDisableAll,
  onOpenDocs,
}: TipPopoverContentProps) {
  return (
    <div className="max-w-[240px]">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-purple-400" />
          <span className="text-[13px] font-semibold text-foreground">
            {tip.title}
          </span>
        </div>
        <button
          onClick={onDismiss}
          className="shrink-0 rounded p-0.5 text-muted-foreground/50 transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mb-2.5 text-xs leading-relaxed text-muted-foreground">
        {tip.body}
      </p>
      <div className="flex items-center justify-between">
        {tip.docsSection ? (
          <button
            onClick={() => onOpenDocs?.(tip.docsSection!)}
            className="text-[11px] text-purple-400/80 transition-colors hover:text-purple-300"
          >
            Learn more →
          </button>
        ) : (
          <span />
        )}
        <button
          onClick={onDisableAll}
          className="text-[10px] text-muted-foreground/40 transition-colors hover:text-muted-foreground"
        >
          Don't show tips
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run type check**

Run: `pnpm run check`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/tips/tip-popover-content.tsx
git commit -m "feat(tips): add TipPopoverContent component"
```

---

### Task 7: TipSpot Wrapper Component

**Files:**

- Create: `apps/web/src/components/tips/tip-spot.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/tips/tip-spot.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTip } from "@/lib/tips/use-tip";

import { TipPopoverContent } from "./tip-popover-content";
import { useTipQueue } from "./tip-queue-provider";

type TipSpotProps = {
  tipId: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  onOpenDocs?: (section: string) => void;
  children: React.ReactNode;
};

export function TipSpot({
  tipId,
  side = "right",
  align = "center",
  sideOffset = 8,
  onOpenDocs,
  children,
}: TipSpotProps) {
  const { tip, shouldShowInline, dismiss, disableAll } = useTip(tipId);
  const { requestOpen, release } = useTipQueue();
  const [open, setOpen] = useState(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!shouldShowInline || mountedRef.current) return;
    mountedRef.current = true;

    const timer = setTimeout(() => {
      if (requestOpen(tipId)) {
        setOpen(true);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [shouldShowInline, tipId, requestOpen]);

  const handleDismiss = useCallback(() => {
    setOpen(false);
    dismiss();
    release(tipId);
  }, [dismiss, release, tipId]);

  const handleDisableAll = useCallback(() => {
    setOpen(false);
    disableAll();
    release(tipId);
  }, [disableAll, release, tipId]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        handleDismiss();
      }
    },
    [handleDismiss]
  );

  if (!tip || !shouldShowInline) {
    return <>{children}</>;
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="w-auto border-purple-500/20"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <TipPopoverContent
          tip={tip}
          onDismiss={handleDismiss}
          onDisableAll={handleDisableAll}
          onOpenDocs={onOpenDocs}
        />
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Run type check**

Run: `pnpm run check`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/tips/tip-spot.tsx
git commit -m "feat(tips): add TipSpot wrapper component"
```

---

### Task 8: AmbientTipBar Component

**Files:**

- Create: `apps/web/src/components/tips/ambient-tip-bar.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/tips/ambient-tip-bar.tsx`:

```tsx
import { AnimatePresence, motion } from "framer-motion";
import { Lightbulb, X } from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import { tips, type Tip } from "@/lib/tips/tips";
import { dismissedTipsAtom, tipsEnabledAtom } from "@/lib/tips/tips-state";

const IDLE_DELAY_MS = 2.5 * 60 * 1000; // 2.5 minutes
const SHOW_CHANCE = 0.4;
const AUTO_HIDE_MS = 30_000;

export function AmbientTipBar({
  onOpenDocs,
}: {
  onOpenDocs?: (section: string) => void;
}) {
  const enabled = useAtomValue(tipsEnabledAtom);
  const dismissed = useAtomValue(dismissedTipsAtom);
  const setDismissed = useSetAtom(dismissedTipsAtom);
  const setEnabled = useSetAtom(tipsEnabledAtom);

  const [visibleTip, setVisibleTip] = useState<Tip | null>(null);
  const shownThisSessionRef = useRef(new Set<string>());
  const hoveredRef = useRef(false);
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const idleTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const getEligibleTip = useCallback((): Tip | null => {
    const eligible = tips.filter(
      (t) =>
        t.surfaces.includes("ambient") &&
        !dismissed.includes(t.id) &&
        !shownThisSessionRef.current.has(t.id)
    );
    if (eligible.length === 0) return null;
    return eligible[Math.floor(Math.random() * eligible.length)]!;
  }, [dismissed]);

  const startAutoHide = useCallback(() => {
    clearTimeout(autoHideTimerRef.current);
    autoHideTimerRef.current = setTimeout(() => {
      if (!hoveredRef.current) {
        setVisibleTip(null);
      }
    }, AUTO_HIDE_MS);
  }, []);

  const resetIdleTimer = useCallback(() => {
    clearTimeout(idleTimerRef.current);
    if (!enabled || visibleTip) return;

    idleTimerRef.current = setTimeout(() => {
      if (Math.random() > SHOW_CHANCE) {
        resetIdleTimer();
        return;
      }
      const tip = getEligibleTip();
      if (tip) {
        shownThisSessionRef.current.add(tip.id);
        setVisibleTip(tip);
        startAutoHide();
      }
    }, IDLE_DELAY_MS);
  }, [enabled, visibleTip, getEligibleTip, startAutoHide]);

  useEffect(() => {
    if (!enabled) {
      setVisibleTip(null);
      return;
    }

    const onActivity = () => {
      if (visibleTip) return;
      resetIdleTimer();
    };

    resetIdleTimer();
    window.addEventListener("mousemove", onActivity);
    window.addEventListener("keydown", onActivity);

    return () => {
      clearTimeout(idleTimerRef.current);
      clearTimeout(autoHideTimerRef.current);
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, [enabled, visibleTip, resetIdleTimer]);

  const handleMouseEnter = useCallback(() => {
    hoveredRef.current = true;
    clearTimeout(autoHideTimerRef.current);
  }, []);

  const handleMouseLeave = useCallback(() => {
    hoveredRef.current = false;
    if (visibleTip) startAutoHide();
  }, [visibleTip, startAutoHide]);

  const handleDismiss = useCallback(() => {
    if (visibleTip) {
      setDismissed((prev) =>
        prev.includes(visibleTip.id) ? prev : [...prev, visibleTip.id]
      );
    }
    setVisibleTip(null);
    clearTimeout(autoHideTimerRef.current);
    resetIdleTimer();
  }, [visibleTip, setDismissed, resetIdleTimer]);

  const handleDisableAll = useCallback(() => {
    setEnabled(false);
    setVisibleTip(null);
    clearTimeout(autoHideTimerRef.current);
  }, [setEnabled]);

  return (
    <AnimatePresence>
      {visibleTip ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
          className="border-t border-border/30 bg-background/50 px-5 py-2"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Lightbulb className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
              <span className="truncate text-xs text-muted-foreground">
                <strong className="font-medium text-muted-foreground/80">
                  {visibleTip.title}
                </strong>
                <span className="mx-1.5 opacity-30">—</span>
                {visibleTip.body}
              </span>
              {visibleTip.docsSection ? (
                <button
                  onClick={() => onOpenDocs?.(visibleTip.docsSection!)}
                  className="shrink-0 text-[11px] text-purple-400/60 transition-colors hover:text-purple-300"
                >
                  Learn more →
                </button>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <button
                onClick={handleDisableAll}
                className="text-[10px] text-muted-foreground/30 transition-colors hover:text-muted-foreground"
              >
                Don't show tips
              </button>
              <button
                onClick={handleDismiss}
                className="rounded p-0.5 text-muted-foreground/30 transition-colors hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
```

- [ ] **Step 2: Run type check**

Run: `pnpm run check`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/tips/ambient-tip-bar.tsx
git commit -m "feat(tips): add AmbientTipBar with idle detection and auto-hide"
```

---

### Task 9: Wire AmbientTipBar into AgentsView

**Files:**

- Modify: `apps/web/src/components/app/agents-view.tsx`

The ambient tip bar goes in the bottom buffer area of the terminal pane. The terminal content div at line 579 has `pb-14` (56px bottom padding) — this is the buffer zone.

- [ ] **Step 1: Add import**

At the top of `apps/web/src/components/app/agents-view.tsx`, add:

```ts
import { AmbientTipBar } from "@/components/tips/ambient-tip-bar";
```

- [ ] **Step 2: Add the tip bar**

Find the `pb-14` div (line 579):

```tsx
<div className="relative h-full min-h-0 min-w-0 pb-14 pt-14">
```

After the `<TerminalPane ... />` closing tag (line 627) and before the closing `</div>` of the `pb-14` container, add the ambient tip bar absolutely positioned in the bottom padding zone:

```tsx
<div className="absolute inset-x-0 bottom-0 z-10">
  <AmbientTipBar />
</div>
```

The full section after the edit (lines ~627-630):

```tsx
                />
                <div className="absolute inset-x-0 bottom-0 z-10">
                  <AmbientTipBar />
                </div>
              </div>
```

This positions the bar inside the 56px (`pb-14`) bottom buffer without affecting terminal layout.

- [ ] **Step 3: Run type check**

Run: `pnpm run check`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/app/agents-view.tsx
git commit -m "feat(tips): wire AmbientTipBar into agents view bottom buffer"
```

---

### Task 10: Wire lastSeenVersion Initialization

**Files:**

- Modify: `apps/web/src/App.tsx`

The `lastSeenVersionAtom` needs to be read on app load, compared against `BUILD_VERSION`, and then updated. This should happen once per session.

- [ ] **Step 1: Create version initializer**

Add a small component in `apps/web/src/App.tsx` (above `DashboardLayout`):

```tsx
import { useAtom } from "jotai";
import { useEffect, useRef } from "react";

import { BUILD_VERSION } from "@/lib/version";
import { lastSeenVersionAtom } from "@/lib/tips/tips-state";

function TipsVersionInit() {
  const [lastSeen, setLastSeen] = useAtom(lastSeenVersionAtom);
  const didInit = useRef(false);

  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    if (lastSeen !== BUILD_VERSION) {
      // Delay the update so TipSpot components can read the old
      // lastSeenVersion during this render cycle and decide which
      // inline tips to show.
      const timer = setTimeout(() => setLastSeen(BUILD_VERSION), 2000);
      return () => clearTimeout(timer);
    }
  }, [lastSeen, setLastSeen]);

  return null;
}
```

- [ ] **Step 2: Render inside DashboardLayout**

In the `DashboardLayout` return (around line 242), add `<TipsVersionInit />` inside the `TipQueueProvider`:

```tsx
return (
  <TipQueueProvider>
    <TipsVersionInit />
    <Outlet context={context} />
    <ReleaseAvailableToast />
    <UpdateAvailableToast />
    <Toaster
      position="bottom-right"
      closeButton
      richColors
      toastOptions={{ duration: 3000 }}
    />
  </TipQueueProvider>
);
```

- [ ] **Step 3: Run type check**

Run: `pnpm run check`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(tips): initialize lastSeenVersion on app load"
```

---

### Task 11: Settings Integration

**Files:**

- Modify: `apps/web/src/components/app/notification-settings.tsx`

- [ ] **Step 1: Add TipsSection component**

At the top of `notification-settings.tsx`, add imports:

```ts
import { useAtom, useSetAtom } from "jotai";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { dismissedTipsAtom, tipsEnabledAtom } from "@/lib/tips/tips-state";
```

After the `SoundCuesSection` component (line 92), add:

```tsx
function TipsSection(): JSX.Element {
  const [enabled, setEnabled] = useAtom(tipsEnabledAtom);
  const setDismissed = useSetAtom(dismissedTipsAtom);

  return (
    <div>
      <h3 className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Tips & Guidance
      </h3>
      <p className="mb-3 text-sm text-muted-foreground">
        Contextual tips that highlight features and link to docs. This device
        only.
      </p>
      <div className="max-w-lg space-y-3">
        <label className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50">
          <Checkbox
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked === true)}
            data-testid="tips-enabled"
          />
          <div className="text-sm font-medium text-foreground">Show tips</div>
        </label>
        <Button
          variant="default"
          size="sm"
          onClick={() => {
            setDismissed([]);
            toast.success(
              "Tips reset — you'll see them again as you use the app."
            );
          }}
          data-testid="reset-dismissed-tips"
          className="gap-1.5"
        >
          <RotateCcw className="h-3 w-3" />
          Reset dismissed tips
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Render TipsSection**

Find where `<SoundCuesSection />` is rendered inside `NotificationSettings`. It should be near the top of the component's JSX. Add `<TipsSection />` right after it, with a border separator:

```tsx
<SoundCuesSection />

<div className="border-t border-border pt-8">
  <TipsSection />
</div>
```

- [ ] **Step 3: Verify existing imports**

Check that `Checkbox`, `Button`, `toast` are already imported in the file. If not, add them. `Checkbox` and `Button` are likely already imported (used by SoundCuesSection). `toast` from `sonner` may need to be added.

- [ ] **Step 4: Run type check**

Run: `pnpm run check`
Expected: No type errors

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/app/notification-settings.tsx
git commit -m "feat(tips): add tips toggle and reset button to notification settings"
```

---

### Task 12: Add a TipSpot to an Existing Feature

**Files:**

- Modify: `apps/web/src/components/app/agents-view.tsx` (QuickPhrasesButton area)

Wire up one `TipSpot` to validate the full inline flow end-to-end.

- [ ] **Step 1: Wrap QuickPhrasesButton with TipSpot**

In `apps/web/src/components/app/agents-view.tsx`, import TipSpot:

```ts
import { TipSpot } from "@/components/tips/tip-spot";
```

Find the `<QuickPhrasesButton>` usage (around line 570):

```tsx
<QuickPhrasesButton
  agentId={hasActiveAgent && connState === "connected" ? focusedAgentId! : null}
  focusTerminal={focusTerminal}
/>
```

Wrap it:

```tsx
<TipSpot tipId="quick-phrases" side="bottom" align="start">
  <QuickPhrasesButton
    agentId={
      hasActiveAgent && connState === "connected" ? focusedAgentId! : null
    }
    focusTerminal={focusTerminal}
  />
</TipSpot>
```

- [ ] **Step 2: Run type check**

Run: `pnpm run check`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/app/agents-view.tsx
git commit -m "feat(tips): add TipSpot to QuickPhrasesButton"
```

---

### Task 13: Finalize and Validate

- [ ] **Step 1: Run full type check**

Run: `pnpm run check`
Expected: No type errors across the workspace

- [ ] **Step 2: Run web finalization**

Run: `pnpm run finalize:web`
Expected: Type check and production build succeed

- [ ] **Step 3: Run unit tests**

Run: `pnpm vitest run apps/web/src/lib/tips/`
Expected: All tests pass

- [ ] **Step 4: Run E2E tests**

Run: `pnpm run test:e2e`
Expected: All existing tests pass (no regressions)

- [ ] **Step 5: Visual validation**

Start a dev server using `repo_dev_up` and validate in Playwright:

1. Open the app
2. Set `dispatch:lastSeenVersion` in localStorage to a version older than "0.23.0"
3. Reload — verify the Quick Phrases TipSpot popover appears
4. Dismiss it — verify it doesn't reappear on reload
5. Go to Settings > Notifications — verify Tips section with toggle and reset button
6. Click "Reset dismissed tips" — verify toast appears
7. Reload — verify the tip can appear again
8. Toggle "Show tips" off — verify no tips appear

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix(tips): address validation feedback"
```
