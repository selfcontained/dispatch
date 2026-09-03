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

// Per-project, per-runtime model preference for the Create Agent dialog.
// null is intentional: it means leave model selection to the CLI.
export const createAgentModelPrefAtom = atomFamily((key: string) =>
  atomWithLocalStorage<string | null>(`dispatch:model:${key}`, null)
);

// Per-project, per-runtime model preference for the Launch Review dialog.
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

export const whiteboardAgentDrewAtomFamily = atomFamily((_agentId: string) =>
  atom(false)
);

// Per-version dismissal for the plugin-update affordance, keyed by
// `<agentType>:<latestVersion>`. Unlike a first-install dismissal (which is
// correctly permanent), an update nudge must not silence every future
// version after one "not now" — a new latestVersion gets its own key and
// shows again on its own.
export const dismissedPluginUpdateAtomFamily = atomFamily((key: string) =>
  atomWithLocalStorage<boolean>(`dispatch:dismissedPluginUpdate:${key}`, false)
);

/**
 * Whether one pin group is collapsed, keyed by `<agentId>::<group>`.
 *
 * Stores the user's *choice*, not the rendered state: `null` means they have
 * never touched this group, which is distinct from having chosen "expanded".
 * The size-based default is applied at render, so a group the user expanded
 * stays expanded when it later grows past the auto-collapse threshold.
 */
export const pinGroupCollapsedAtomFamily = atomFamily((key: string) =>
  atomWithLocalStorage<boolean | null>(
    `dispatch:pinGroupCollapsed:${key}`,
    null
  )
);

/**
 * Collapse choice for a sub agent's media group under its parent's Media tab,
 * keyed `parentId::childId`. Same `null` = untouched convention as pin groups;
 * the default (expanded) is applied at render.
 */
export const mediaGroupCollapsedAtomFamily = atomFamily((key: string) =>
  atomWithLocalStorage<boolean | null>(
    `dispatch:mediaGroupCollapsed:${key}`,
    null
  )
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

export const SYSTEM_SIDEBAR_TABS = [
  "pins",
  "media",
  "reviews",
  "messages",
] as const;

export type SystemSidebarTab = (typeof SYSTEM_SIDEBAR_TABS)[number];

export function isSystemSidebarTab(
  tab: MediaSidebarTab
): tab is SystemSidebarTab {
  return (SYSTEM_SIDEBAR_TABS as readonly string[]).includes(tab);
}

// A custom tab's active id is the agent-issued surface id (e.g. "srf_...").
// Widened to `string` rather than kept as a literal union — unlike the four
// system tabs, the set of valid values is open-ended and server-issued.
export type MediaSidebarTab = SystemSidebarTab | (string & {});

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
  reconcileAgentScopedStorageDomains(agentIds, [
    { prefix: MEDIA_SIDEBAR_STATE_STORAGE_PREFIX },
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
  reconcileAgentScopedStorageDomains(agentIds, [
    { prefix: REVIEW_DRAFTS_STORAGE_PREFIX },
  ]);
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
  reconcileAgentScopedStorageDomains(agentIds, [
    { prefix: DIFF_VIEW_STATE_STORAGE_PREFIX },
  ]);
}

// ---------------------------------------------------------------------------
// Split pane state — per-agent split/single mode and pane sizes
// ---------------------------------------------------------------------------

export type CenterTab = "terminal" | "changes" | "whiteboard";

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
  reconcileAgentScopedStorageDomains(agentIds, [
    { prefix: SPLIT_PANE_STATE_STORAGE_PREFIX },
  ]);
}

// ---------------------------------------------------------------------------
// Agent-authored surface tab presentation prefs — per-agent user-chosen order
// and hidden set, layered over the server's canonical sortOrder. The server
// document (blocks, titles, sortOrder) is never mutated from here; see
// use-surface-tab-prefs.ts for how these are merged with live surface data.
// ---------------------------------------------------------------------------

export const CUSTOM_TAB_ORDER_STORAGE_PREFIX = "dispatch:customTabOrder:";

export const customTabOrderAtomFamily = atomFamily((agentId: string) =>
  atomWithLocalStorage<string[]>(
    `${CUSTOM_TAB_ORDER_STORAGE_PREFIX}${agentId}`,
    []
  )
);

export function reconcileCustomTabOrderStorage(
  agentIds: Iterable<string>
): void {
  reconcileAgentScopedStorageDomains(agentIds, [
    { prefix: CUSTOM_TAB_ORDER_STORAGE_PREFIX },
  ]);
}

export const CUSTOM_TAB_HIDDEN_STORAGE_PREFIX = "dispatch:customTabHidden:";

export const customTabHiddenAtomFamily = atomFamily((agentId: string) =>
  atomWithLocalStorage<string[]>(
    `${CUSTOM_TAB_HIDDEN_STORAGE_PREFIX}${agentId}`,
    []
  )
);

export function reconcileCustomTabHiddenStorage(
  agentIds: Iterable<string>
): void {
  reconcileAgentScopedStorageDomains(agentIds, [
    { prefix: CUSTOM_TAB_HIDDEN_STORAGE_PREFIX },
  ]);
}

// ---------------------------------------------------------------------------
// Seen surface ids — per-agent record of which agent-authored tabs the user
// has already opened, so the tab strip can flag a newly-encountered surface
// id as "new" until it's viewed. See surface-tab-row.tsx.
// ---------------------------------------------------------------------------

export const SEEN_SURFACE_IDS_STORAGE_PREFIX = "dispatch:seenSurfaceIds:";

export const seenSurfaceIdsAtomFamily = atomFamily((agentId: string) =>
  atomWithLocalStorage<string[]>(
    `${SEEN_SURFACE_IDS_STORAGE_PREFIX}${agentId}`,
    []
  )
);

export function reconcileSeenSurfaceIdsStorage(
  agentIds: Iterable<string>
): void {
  reconcileAgentScopedStorageDomains(agentIds, [
    { prefix: SEEN_SURFACE_IDS_STORAGE_PREFIX },
  ]);
}

// ---------------------------------------------------------------------------
// Surface form drafts — unsubmitted input for one form block, keyed by
// `<agentId>:<surfaceId>:<blockId>`. Typing never notifies the agent; a draft
// survives tab switches and reloads, then clears on successful submit or
// explicit Reset (see use-surface-form-draft.ts).
// ---------------------------------------------------------------------------

export type SurfaceFormDraft = Record<
  string,
  string | number | boolean | null | string[]
>;

export const SURFACE_FORM_DRAFT_STORAGE_PREFIX = "dispatch:surfaceFormDraft:";

export const surfaceFormDraftAtomFamily = atomFamily((draftKey: string) =>
  atomWithLocalStorage<SurfaceFormDraft | null>(
    `${SURFACE_FORM_DRAFT_STORAGE_PREFIX}${draftKey}`,
    null
  )
);

/** Drops drafts whose `<agentId>:...` prefix no longer names a live agent. */
export function reconcileSurfaceFormDraftStorage(
  agentIds: Iterable<string>
): void {
  reconcileAgentScopedStorageDomains(agentIds, [
    {
      prefix: SURFACE_FORM_DRAFT_STORAGE_PREFIX,
      agentIdFromSuffix: (draftKey) => draftKey.split(":")[0],
    },
  ]);
}

// ---------------------------------------------------------------------------
// Message group collapsed state — per-agent set of collapsed thread IDs
// ---------------------------------------------------------------------------

export const MESSAGE_GROUPS_STATE_STORAGE_PREFIX =
  "dispatch:messageGroupsState:";

export const messageGroupsCollapsedAtomFamily = atomFamily((agentId: string) =>
  atomWithLocalStorage<string[]>(
    `${MESSAGE_GROUPS_STATE_STORAGE_PREFIX}${agentId}`,
    []
  )
);

export function reconcileMessageGroupsStateStorage(
  agentIds: Iterable<string>
): void {
  reconcileAgentScopedStorageDomains(agentIds, [
    { prefix: MESSAGE_GROUPS_STATE_STORAGE_PREFIX },
  ]);
}

const AGENT_SCOPED_STORAGE_DOMAINS: readonly AgentScopedStorageDomain[] = [
  { prefix: MEDIA_SIDEBAR_STATE_STORAGE_PREFIX },
  { prefix: REVIEW_DRAFTS_STORAGE_PREFIX },
  { prefix: DIFF_VIEW_STATE_STORAGE_PREFIX },
  { prefix: SPLIT_PANE_STATE_STORAGE_PREFIX },
  { prefix: CUSTOM_TAB_ORDER_STORAGE_PREFIX },
  { prefix: CUSTOM_TAB_HIDDEN_STORAGE_PREFIX },
  { prefix: SEEN_SURFACE_IDS_STORAGE_PREFIX },
  {
    prefix: SURFACE_FORM_DRAFT_STORAGE_PREFIX,
    agentIdFromSuffix: (draftKey) => draftKey.split(":")[0],
  },
  { prefix: MESSAGE_GROUPS_STATE_STORAGE_PREFIX },
];

/** Reconciles every per-agent persisted UI state in a single storage scan. */
export function reconcileAgentScopedStorage(agentIds: Iterable<string>): void {
  reconcileAgentScopedStorageDomains(agentIds, AGENT_SCOPED_STORAGE_DOMAINS);
}
