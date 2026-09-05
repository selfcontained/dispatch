import { atom } from "jotai";
import { atomFamily } from "jotai/utils";

import {
  type CenterTab,
  isCenterTab,
  isLegacyCenterTab,
  type LegacyCenterTab,
} from "./center-tabs";
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
   * Older key to read when `key` is absent. Read-only migration path: writes
   * go to `key` alone, so a client rolled back to the old schema only ever
   * sees values it wrote itself.
   */
  legacyKey?: string;
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
        let stored = window.localStorage.getItem(key);
        if (stored === null && options.legacyKey !== undefined) {
          stored = window.localStorage.getItem(options.legacyKey);
        }
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

/**
 * Last value of the `chat_surface_enabled` flag this browser saw. The server
 * owns the flag (see `useChatSurfaceEnabled`); this only lets the first paint
 * of the agent view pick the right tab before the fetch resolves, so the
 * Console never flashes under the Chat tab. `null` until the first fetch.
 */
export const chatSurfaceEnabledHintAtom = atomWithLocalStorage<boolean | null>(
  "dispatch:chatSurfaceEnabledHint",
  null
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

export type SplitPaneMode = "single" | "split";

/** What the layout renders: sides drawn from the current tab set only. */
export type SplitPaneState = {
  mode: SplitPaneMode;
  left: CenterTab;
  right: CenterTab;
  sizes: [number, number];
};

/**
 * What storage holds. Sides may still carry the round-1/2 "chat" id (and
 * "terminal"/"agent" from under the other flag value);
 * `normalizeSplitPaneState` in use-split-pane.ts turns one of these into a
 * `SplitPaneState` before anything renders it.
 */
export type PersistedSplitPaneState = {
  mode: SplitPaneMode;
  left: LegacyCenterTab;
  right: LegacyCenterTab;
  sizes: [number, number];
};

export const defaultSplitPaneState: SplitPaneState = {
  mode: "single",
  left: "terminal",
  right: "changes",
  sizes: [50, 50],
};

/** Stored values are user-editable localStorage; anything off-shape reads as the default. */
export function isPersistedSplitPaneState(
  value: unknown
): value is PersistedSplitPaneState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    (state.mode === "single" || state.mode === "split") &&
    isLegacyCenterTab(state.left) &&
    isLegacyCenterTab(state.right) &&
    Array.isArray(state.sizes) &&
    state.sizes.length === 2 &&
    state.sizes.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/** A persisted state whose sides are already current tabs, as stored by this build. */
export function isCurrentSplitPaneState(
  state: PersistedSplitPaneState
): state is SplitPaneState {
  return isCenterTab(state.left) && isCenterTab(state.right);
}

// Typed as the persisted shape so it can stand in for a family member in
// `useSplitPane`; the default it holds is a current-shape state.
export const inactiveSplitPaneStateAtom = atom<PersistedSplitPaneState>(
  defaultSplitPaneState
);

/**
 * Versioned key. v1 (`dispatch:splitPane:`) predates the "chat" tab; a client
 * rolled back to a v1 build reading "chat" out of its own key would render a
 * blank pane, so the current schema lives under its own key and the legacy
 * one is only ever read (see `atomWithLocalStorage`'s `legacyKey`).
 */
export const SPLIT_PANE_STATE_STORAGE_PREFIX = "dispatch:splitPaneV2:";
export const LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX = "dispatch:splitPane:";

export const splitPaneStateAtomFamily = atomFamily((agentId: string) =>
  atomWithLocalStorage<PersistedSplitPaneState>(
    `${SPLIT_PANE_STATE_STORAGE_PREFIX}${agentId}`,
    defaultSplitPaneState,
    {
      legacyKey: `${LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX}${agentId}`,
      validate: isPersistedSplitPaneState,
    }
  )
);

/**
 * Round 1/2 remembered a last-picked center tab under this prefix so the bare
 * agent route could land on Chat. The Agent pane replaced that with a view
 * toggle (`agentPaneViewAtomFamily`); the prefix is only kept so the
 * reconciler still sweeps the old keys.
 */
export const LEGACY_CENTER_TAB_STORAGE_PREFIX = "dispatch:centerTab:";

// ---------------------------------------------------------------------------
// Agent pane view — which of Chat / Console the Agent tab shows, per agent.
// Not in the URL on purpose: it is a preference, not a place, and the /chat
// route of round 1 only survives as a redirect that flips it to "chat".
// ---------------------------------------------------------------------------

export type AgentPaneView = "harness" | "chat" | "console";

export const AGENT_PANE_VIEW_STORAGE_PREFIX = "dispatch:agentPaneView:";

/**
 * `null` until the user picks a view: the pane then opens on the type's
 * default (`defaultAgentPaneView`), which a stored "chat" could not express.
 */
export const agentPaneViewAtomFamily = atomFamily((agentId: string) =>
  atomWithLocalStorage<AgentPaneView | null>(
    `${AGENT_PANE_VIEW_STORAGE_PREFIX}${agentId}`,
    null
  )
);

export const inactiveAgentPaneViewAtom = atom<AgentPaneView | null>(null);

export function isAgentPaneView(value: unknown): value is AgentPaneView {
  return value === "harness" || value === "chat" || value === "console";
}

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
    { prefix: LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX },
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
  { prefix: LEGACY_SPLIT_PANE_STATE_STORAGE_PREFIX },
  { prefix: LEGACY_CENTER_TAB_STORAGE_PREFIX },
  { prefix: AGENT_PANE_VIEW_STORAGE_PREFIX },
  { prefix: CHAT_DRAFT_STORAGE_PREFIX },
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

// ---------------------------------------------------------------------------
// Live terminal signals for the chat presence strip — ephemeral, per agent,
// never persisted. Written by the terminal socket (output) and the SSE
// stream (tool invocations); readable while the pane is hidden under Chat.
// ---------------------------------------------------------------------------

export type TerminalOutputActivity = {
  /** `Date.now()` of the last output flush; 0 until any output is seen. */
  lastOutputAt: number;
  /** Throughput over the window that ended at `lastOutputAt`. */
  bytesPerSecond: number;
};

export const terminalOutputActivityAtomFamily = atomFamily((_agentId: string) =>
  atom<TerminalOutputActivity>({ lastOutputAt: 0, bytesPerSecond: 0 })
);

export type AgentToolBlip = {
  /** MCP tool name as the server reported it, e.g. `dispatch_share_file`. */
  tool: string;
  /** `Date.now()` on receipt — local time, so the blip's timer ignores clock skew. */
  at: number;
};

export const agentToolBlipAtomFamily = atomFamily((_agentId: string) =>
  atom<AgentToolBlip | null>(null)
);

/**
 * The view an Agent pane opens on before the user picks one: the Harness
 * view for a Dispatch Harness agent, Chat for every other.
 */
export function defaultAgentPaneView(
  agentType: string | null | undefined
): AgentPaneView {
  return agentType === "dsh" ? "harness" : "chat";
}
