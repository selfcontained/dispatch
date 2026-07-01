import { atom } from "jotai";
import { atomFamily } from "jotai/utils";

import { type IdeType } from "./ide-types";

export function atomWithLocalStorage<T>(key: string, initialValue: T) {
  const baseAtom = atom<T>(
    (() => {
      if (typeof window === "undefined") return initialValue;
      try {
        const stored = window.localStorage.getItem(key);
        if (stored === null) return initialValue;
        return JSON.parse(stored) as T;
      } catch {
        return initialValue;
      }
    })()
  );

  // Subscribe to cross-tab `storage` events while any consumer of this
  // atom is mounted, so a write in tab A propagates to tab B without a
  // reload. Same-tab writes still go through the derived setter below.
  // (`storage` only fires for changes from *other* tabs, so there's no
  // self-echo to worry about.)
  baseAtom.onMount = (setSelf) => {
    if (typeof window === "undefined") return;
    const handle = (event: StorageEvent) => {
      if (event.key !== key) return;
      if (event.newValue === null) {
        setSelf(initialValue);
        return;
      }
      try {
        setSelf(JSON.parse(event.newValue) as T);
      } catch {
        // Ignore malformed payloads from other tabs — keep current state.
      }
    };
    window.addEventListener("storage", handle);
    return () => window.removeEventListener("storage", handle);
  };

  const derivedAtom = atom(
    (get) => get(baseAtom),
    (_get, set, update: T | ((prev: T) => T)) => {
      const nextValue =
        typeof update === "function"
          ? (update as (prev: T) => T)(_get(baseAtom))
          : update;
      set(baseAtom, nextValue);
      window.localStorage.setItem(key, JSON.stringify(nextValue));
    }
  );

  return derivedAtom;
}

export const leftSidebarOpenAtom = atomWithLocalStorage(
  "dispatch:leftSidebarOpen",
  true
);
export const soundCuesEnabledAtom = atomWithLocalStorage(
  "dispatch:soundCuesEnabled",
  true
);

export const preferredIdeAtom = atomWithLocalStorage<IdeType>(
  "dispatch:preferredIde",
  "vscode"
);

// Cached view of the server-wide cross-repo messaging gate (lets agents
// message/list agents in OTHER repositories). The server enforces and owns the
// value; CrossRepoMessagingSettings hydrates this atom from the GET endpoint on
// mount and writes back only on an explicit toggle. localStorage just gives an
// instant first paint before the GET resolves. Default off.
export const crossRepoMessagingEnabledAtom = atomWithLocalStorage<boolean>(
  "dispatch:crossRepoMessaging",
  false
);

// Per-cwd preferences for the Create Agent dialog. Each cwd gets its own
// atom backed by localStorage; the family caches them by trimmed cwd.
export const createNewBranchPrefAtom = atomFamily((cwd: string) =>
  atomWithLocalStorage<boolean>(`dispatch:createNewBranch:${cwd}`, true)
);

// Per-tag dismissal flag for the "release available" toast. Dismissing
// vX.Y.Z prevents that toast from re-showing for the same tag, but a
// newer tag still triggers a fresh toast on its own atom.
export const dismissedReleaseToastAtomFamily = atomFamily((tag: string) =>
  atomWithLocalStorage<boolean>(`dispatch:dismissedReleaseToast:${tag}`, false)
);

export type DiffViewType = "unified" | "split";

export const diffViewTypeAtom = atomWithLocalStorage<DiffViewType>(
  "dispatch:diffViewType",
  "unified"
);

export const diffIgnoreWhitespaceAtom = atomWithLocalStorage<boolean>(
  "dispatch:diffIgnoreWhitespace",
  true
);

export const diffFileTreeOpenAtom = atomWithLocalStorage<boolean>(
  "dispatch:diffFileTreeOpen",
  true
);

export const agentSidebarOrderAtom = atomWithLocalStorage<string[]>(
  "dispatch:agentSidebarOrder",
  []
);

export function reconcileAgentSidebarOrder(
  storedOrder: readonly string[],
  agentIds: readonly string[]
): string[] {
  const liveIds = new Set(agentIds);
  const seen = new Set<string>();
  const nextOrder: string[] = [];

  for (const agentId of agentIds) {
    if (storedOrder.includes(agentId) || seen.has(agentId)) continue;
    seen.add(agentId);
    nextOrder.push(agentId);
  }

  for (const agentId of storedOrder) {
    if (!liveIds.has(agentId) || seen.has(agentId)) continue;
    seen.add(agentId);
    nextOrder.push(agentId);
  }

  return nextOrder;
}

export type MediaSidebarTab = "pins" | "media" | "brain" | "reviews" | "messages";

export type MediaSidebarState = {
  isOpen: boolean;
  activeTab: MediaSidebarTab;
  // When true (desktop only), the sidebar takes layout space and shrinks the
  // terminal. When false, the sidebar floats over the terminal as a drawer
  // that slides in/out without shifting layout. Default is false.
  isPinned: boolean;
};

export const defaultMediaSidebarState: MediaSidebarState = {
  isOpen: false,
  activeTab: "pins",
  isPinned: false,
};

export const inactiveMediaSidebarStateAtom = atom<MediaSidebarState>(
  defaultMediaSidebarState
);

export const MEDIA_SIDEBAR_STATE_STORAGE_PREFIX = "dispatch:mediaSidebarState:";

export const mediaSidebarStateAtomFamily = atomFamily((agentId: string) =>
  atomWithLocalStorage<MediaSidebarState>(
    `${MEDIA_SIDEBAR_STATE_STORAGE_PREFIX}${agentId}`,
    defaultMediaSidebarState
  )
);

export function reconcileMediaSidebarStateStorage(
  agentIds: Iterable<string>
): void {
  if (typeof window === "undefined") return;

  const liveAgentIds = new Set(agentIds);
  const keysToDelete: string[] = [];

  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key?.startsWith(MEDIA_SIDEBAR_STATE_STORAGE_PREFIX)) continue;

    const agentId = key.slice(MEDIA_SIDEBAR_STATE_STORAGE_PREFIX.length).trim();
    if (!agentId || liveAgentIds.has(agentId)) continue;
    keysToDelete.push(key);
  }

  keysToDelete.forEach((key) => window.localStorage.removeItem(key));
}

// ---------------------------------------------------------------------------
// Diff view state — per-agent collapsed files/dirs and scroll position
// ---------------------------------------------------------------------------

export type DiffViewState = {
  collapsedFiles: string[];
  collapsedDirs: string[];
  scrollTop: number;
};

const defaultDiffViewState: DiffViewState = {
  collapsedFiles: [],
  collapsedDirs: [],
  scrollTop: 0,
};

export type PersistedDraftComment = {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  comment: string;
};

type ReviewDraftState = {
  reviewMode: boolean;
  drafts: PersistedDraftComment[];
  nextId: number;
};

const defaultReviewDraftState: ReviewDraftState = {
  reviewMode: false,
  drafts: [],
  nextId: 0,
};

export const REVIEW_DRAFTS_STORAGE_PREFIX = "dispatch:review-drafts:";

export const reviewDraftAtomFamily = atomFamily((agentId: string) =>
  atomWithLocalStorage<ReviewDraftState>(
    `${REVIEW_DRAFTS_STORAGE_PREFIX}${agentId}`,
    defaultReviewDraftState
  )
);

export function reconcileReviewDraftStorage(agentIds: Iterable<string>): void {
  if (typeof window === "undefined") return;
  const liveAgentIds = new Set(agentIds);
  const keysToDelete: string[] = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key?.startsWith(REVIEW_DRAFTS_STORAGE_PREFIX)) continue;
    const agentId = key.slice(REVIEW_DRAFTS_STORAGE_PREFIX.length).trim();
    if (!agentId || liveAgentIds.has(agentId)) continue;
    keysToDelete.push(key);
  }
  keysToDelete.forEach((key) => window.localStorage.removeItem(key));
}

export const DIFF_VIEW_STATE_STORAGE_PREFIX = "dispatch:diffViewState:";

export const diffViewStateAtomFamily = atomFamily((agentId: string) =>
  atomWithLocalStorage<DiffViewState>(
    `${DIFF_VIEW_STATE_STORAGE_PREFIX}${agentId}`,
    defaultDiffViewState
  )
);

export function reconcileDiffViewStateStorage(
  agentIds: Iterable<string>
): void {
  if (typeof window === "undefined") return;

  const liveAgentIds = new Set(agentIds);
  const keysToDelete: string[] = [];

  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key?.startsWith(DIFF_VIEW_STATE_STORAGE_PREFIX)) continue;

    const agentId = key.slice(DIFF_VIEW_STATE_STORAGE_PREFIX.length).trim();
    if (!agentId || liveAgentIds.has(agentId)) continue;
    keysToDelete.push(key);
  }

  keysToDelete.forEach((key) => window.localStorage.removeItem(key));
}

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

export const inactiveSplitPaneStateAtom = atom<SplitPaneState>(
  defaultSplitPaneState
);

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
