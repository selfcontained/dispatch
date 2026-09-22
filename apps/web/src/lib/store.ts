import { atom } from "jotai";
import { atomFamily } from "jotai/utils";

import { type CenterTab, isCenterTab } from "./center-tabs";
import {
  type ChatComposerDraft,
  EMPTY_CHAT_DRAFT,
  fitChatDraft,
  isChatComposerDraft,
} from "./chat-draft";
import { type IdeType } from "./ide-types";

export { type CenterTab } from "./center-tabs";

type AtomWithLocalStorageOptions<T> = {
  /**
   * Shape check for what comes back from storage (user-editable, and maybe
   * written by another build). A value that fails it reads as
   * `initialValue`. Without one, whatever parses is trusted as a `T`.
   */
  validate?: (value: unknown) => value is T;
  /**
   * What actually gets written for a value — for state whose stored form is
   * a bounded, lossy snapshot of the in-memory one. The atom itself always
   * holds the value as set; only storage (and so other tabs, and the next
   * reload) sees the snapshot. Defaults to `JSON.stringify`.
   */
  serialize?: (value: T) => string;
};

export function atomWithLocalStorage<T>(
  key: string,
  initialValue: T,
  options: AtomWithLocalStorageOptions<T> = {}
) {
  const parse = (raw: string): T => {
    const value: unknown = JSON.parse(raw);
    if (options.validate && !options.validate(value)) return initialValue;
    return value as T;
  };
  const serialize = options.serialize ?? ((value: T) => JSON.stringify(value));

  const baseAtom = atom<T>(
    (() => {
      if (typeof window === "undefined") return initialValue;
      try {
        const stored = window.localStorage.getItem(key);
        if (stored === null) return initialValue;
        return parse(stored);
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
        setSelf(parse(event.newValue));
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
      const prevValue = _get(baseAtom);
      const nextValue =
        typeof update === "function"
          ? (update as (prev: T) => T)(prevValue)
          : update;
      // An update that hands back the current value changes nothing here,
      // so it must not touch storage either: another tab may have written
      // a newer value since this one was read, and re-writing our copy
      // would fire a `storage` event there and clobber it with stale data.
      if (Object.is(nextValue, prevValue)) return;
      set(baseAtom, nextValue);
      try {
        window.localStorage.setItem(key, serialize(nextValue));
      } catch {
        // Quota exceeded, storage disabled, or a serializer bug: the
        // in-memory value is already set and stays the truth for this
        // session; it just will not outlive it.
      }
    }
  );

  return derivedAtom;
}

export const leftSidebarOpenAtom = atomWithLocalStorage(
  "dispatch:leftSidebarOpen",
  true
);
// The right-hand drawer's width, dragged by its left edge. One width for the
// client: the sidebar and every agent's thread drawer share it. null until
// someone resizes it, so the default in drawer-constants stays the default.
// Stored as dragged; it is clamped to the viewport where it is read, so a
// width saved on a wide monitor comes back whole when the window does.
export const drawerWidthAtom = atomWithLocalStorage<number | null>(
  "dispatch:drawerWidth",
  null,
  {
    validate: (value): value is number | null =>
      value === null || (typeof value === "number" && Number.isFinite(value)),
  }
);

// Collapsed state for the desktop-only bar under the center pane. Default
// expanded: on iPad-with-keyboard setups the bar buffers iPadOS's floating
// keyboard control, which can't be dismissed, so it must stay opt-out.
export const bottomBarCollapsedAtom = atomWithLocalStorage<boolean>(
  "dispatch:bottomBarCollapsed",
  false
);
export const soundCuesEnabledAtom = atomWithLocalStorage(
  "dispatch:soundCuesEnabled",
  true
);

export const preferredIdeAtom = atomWithLocalStorage<IdeType>(
  "dispatch:preferredIde",
  "vscode"
);

// Per-cwd preferences for the Create Agent dialog. Each cwd gets its own
// atom backed by localStorage; the family caches them by trimmed cwd.
export const createNewBranchPrefAtom = atomFamily((cwd: string) =>
  atomWithLocalStorage<boolean>(`dispatch:createNewBranch:${cwd}`, true)
);

// Per-project, per-runtime model preference for the Create Agent dialog.
// null is intentional: it means leave model selection to the CLI.
export const createAgentModelPrefAtom = atomFamily((key: string) =>
  atomWithLocalStorage<string | null>(`dispatch:model:${key}`, null)
);

// Per-project, per-runtime model preference for the persona launcher.
// Kept separate from the Create Agent preference so picking a heavier model
// for reviewers doesn't change what new agents are created with.
export const reviewAgentModelPrefAtom = atomFamily((key: string) =>
  atomWithLocalStorage<string | null>(`dispatch:reviewModel:${key}`, null)
);

// Per-tag dismissal flag for the "release available" toast. Dismissing
// vX.Y.Z prevents that toast from re-showing for the same tag, but a
// newer tag still triggers a fresh toast on its own atom.
export const dismissedReleaseToastAtomFamily = atomFamily((tag: string) =>
  atomWithLocalStorage<boolean>(`dispatch:dismissedReleaseToast:${tag}`, false)
);

// Per-version dismissal for the plugin-update affordance, keyed by
// `<agentType>:<latestVersion>`. Unlike a first-install dismissal (which is
// correctly permanent), an update nudge must not silence every future
// version after one "not now" — a new latestVersion gets its own key and
// shows again on its own.
export const dismissedPluginUpdateAtomFamily = atomFamily((key: string) =>
  atomWithLocalStorage<boolean>(`dispatch:dismissedPluginUpdate:${key}`, false)
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

export const diffIncludeUncommittedAtom = atomWithLocalStorage<boolean>(
  "dispatch:diffIncludeUncommitted",
  true
);

export const diffHideTestFilesAtom = atomWithLocalStorage<boolean>(
  "dispatch:diffHideTestFiles",
  false
);

/** Which comparison the Changes pane uses for a modified image. */
export type DiffImageCompareMode = "two-up" | "swipe" | "onion";

export const diffImageCompareModeAtom =
  atomWithLocalStorage<DiffImageCompareMode>(
    "dispatch:diffImageCompareMode",
    "two-up"
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

/**
 * The right sidebar's tabs: the Inbox (what the stream needs from the user
 * right now, and the links it produced) and the agent's files.
 */
export const DRAWER_TABS = ["inbox", "files"] as const;

export type DrawerTab = (typeof DRAWER_TABS)[number];

/** A stored tab id; anything unknown (an old rail/pins/reviews/surface tab) is the Inbox. */
export function asDrawerTab(tab: unknown): DrawerTab {
  return (DRAWER_TABS as readonly unknown[]).includes(tab)
    ? (tab as DrawerTab)
    : "inbox";
}

type AgentScopedStorageDomain = {
  prefix: string;
  agentIdFromSuffix?: (suffix: string) => string | undefined;
};

/** Removes stale agent-owned keys in one pass without touching other storage. */
function reconcileAgentScopedStorageDomains(
  agentIds: Iterable<string>,
  domains: readonly AgentScopedStorageDomain[]
): void {
  if (typeof window === "undefined") return;

  const liveAgentIds = new Set(agentIds);
  const keysToDelete: string[] = [];

  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key) continue;

    const domain = domains.find(({ prefix }) => key.startsWith(prefix));
    if (!domain) continue;

    const suffix = key.slice(domain.prefix.length);
    const agentId = (domain.agentIdFromSuffix?.(suffix) ?? suffix).trim();
    if (!agentId || liveAgentIds.has(agentId)) continue;
    keysToDelete.push(key);
  }

  keysToDelete.forEach((key) => window.localStorage.removeItem(key));
}

export type DrawerState = {
  isOpen: boolean;
  activeTab: DrawerTab;
  // When true (desktop only), the sidebar takes layout space and shrinks the
  // content. When false, the sidebar floats over the content as a drawer
  // that slides in/out without shifting layout. Default is false.
  isPinned: boolean;
};

export const defaultDrawerState: DrawerState = {
  isOpen: false,
  activeTab: "inbox",
  isPinned: false,
};

export const inactiveDrawerStateAtom = atom<DrawerState>(defaultDrawerState);

export const DRAWER_STATE_STORAGE_PREFIX = "dispatch:drawerState:";

export const drawerStateAtomFamily = atomFamily((agentId: string) =>
  atomWithLocalStorage<DrawerState>(
    `${DRAWER_STATE_STORAGE_PREFIX}${agentId}`,
    defaultDrawerState
  )
);

export function reconcileDrawerStateStorage(agentIds: Iterable<string>): void {
  reconcileAgentScopedStorageDomains(agentIds, [
    { prefix: DRAWER_STATE_STORAGE_PREFIX },
  ]);
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
  /** The finding's severity once the review is posted; `minor` when unset. */
  severity?: "blocker" | "major" | "minor" | "nit";
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
  reconcileAgentScopedStorageDomains(agentIds, [
    { prefix: DIFF_VIEW_STATE_STORAGE_PREFIX },
  ]);
}

// ---------------------------------------------------------------------------
// Split pane state — per-agent split/single mode and pane sizes
// ---------------------------------------------------------------------------

export type SplitPaneMode = "single" | "split";

/** What the layout renders: sides drawn from the current tab set only. */
export type SplitPaneState = {
  mode: SplitPaneMode;
  left: CenterTab;
  right: CenterTab;
  sizes: [number, number];
};

export const defaultSplitPaneState: SplitPaneState = {
  mode: "single",
  left: "agent",
  right: "changes",
  sizes: [50, 50],
};

/** Stored values are user-editable localStorage; anything off-shape reads as the default. */
export function isSplitPaneState(value: unknown): value is SplitPaneState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    (state.mode === "single" || state.mode === "split") &&
    isCenterTab(state.left) &&
    isCenterTab(state.right) &&
    Array.isArray(state.sizes) &&
    state.sizes.length === 2 &&
    state.sizes.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

export const inactiveSplitPaneStateAtom = atom<SplitPaneState>(
  defaultSplitPaneState
);

export const SPLIT_PANE_STATE_STORAGE_PREFIX = "dispatch:splitPaneV2:";

export const splitPaneStateAtomFamily = atomFamily((agentId: string) =>
  atomWithLocalStorage<SplitPaneState>(
    `${SPLIT_PANE_STATE_STORAGE_PREFIX}${agentId}`,
    defaultSplitPaneState,
    { validate: isSplitPaneState }
  )
);

// ---------------------------------------------------------------------------
// Chat child-agent filter — whether Chat shows the messages exchanged with an
// agent's children. One global preference: wanting child chatter out of the
// way is a standing taste, and scoping it per agent would leave every new
// session starting noisy again.
// ---------------------------------------------------------------------------

export const CHAT_SHOW_CHILD_AGENTS_STORAGE_KEY =
  "dispatch:chatShowChildAgents";

export const chatShowChildAgentsAtom = atomWithLocalStorage<boolean>(
  CHAT_SHOW_CHILD_AGENTS_STORAGE_KEY,
  true,
  { validate: (value): value is boolean => typeof value === "boolean" }
);

// ---------------------------------------------------------------------------
// Chat composer drafts — what was typed and attached but not yet sent, per
// agent. The atom holds the full draft; storage gets `fitChatDraft`'s
// bounded snapshot of it. See lib/chat-draft.ts for the shape and the cap.
// ---------------------------------------------------------------------------

export const CHAT_DRAFT_STORAGE_PREFIX = "dispatch:chatDraft:";

export const chatDraftAtomFamily = atomFamily((agentId: string) =>
  atomWithLocalStorage<ChatComposerDraft>(
    `${CHAT_DRAFT_STORAGE_PREFIX}${agentId}`,
    EMPTY_CHAT_DRAFT,
    {
      validate: isChatComposerDraft,
      serialize: (draft) => JSON.stringify(fitChatDraft(draft)),
    }
  )
);

export function reconcileSplitPaneStateStorage(
  agentIds: Iterable<string>
): void {
  reconcileAgentScopedStorageDomains(agentIds, [
    { prefix: SPLIT_PANE_STATE_STORAGE_PREFIX },
  ]);
}

const AGENT_SCOPED_STORAGE_DOMAINS: readonly AgentScopedStorageDomain[] = [
  { prefix: DRAWER_STATE_STORAGE_PREFIX },
  { prefix: REVIEW_DRAFTS_STORAGE_PREFIX },
  { prefix: DIFF_VIEW_STATE_STORAGE_PREFIX },
  { prefix: SPLIT_PANE_STATE_STORAGE_PREFIX },
  { prefix: CHAT_DRAFT_STORAGE_PREFIX },
];

/** Reconciles every per-agent persisted UI state in a single storage scan. */
export function reconcileAgentScopedStorage(agentIds: Iterable<string>): void {
  reconcileAgentScopedStorageDomains(agentIds, AGENT_SCOPED_STORAGE_DOMAINS);
}
