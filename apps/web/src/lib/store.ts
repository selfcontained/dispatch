import { atom } from "jotai";
import { atomFamily } from "jotai/utils";

import { type IdeType } from "./ide-types";

function atomWithLocalStorage<T>(key: string, initialValue: T) {
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

export type MediaSidebarTab = "pins" | "media";

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
