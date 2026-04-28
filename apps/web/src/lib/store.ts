import { atom } from "jotai";
import { atomFamily } from "jotai/utils";

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
export const mediaSidebarOpenAtom = atomWithLocalStorage(
  "dispatch:mediaSidebarOpen",
  false
);
export const mediaSidebarTabAtom = atomWithLocalStorage<"pins" | "media">(
  "dispatch:mediaSidebarTab",
  "pins"
);
export const soundCuesEnabledAtom = atomWithLocalStorage(
  "dispatch:soundCuesEnabled",
  true
);

export type PreferredIde = "vscode" | "cursor";
export const preferredIdeAtom = atomWithLocalStorage<PreferredIde>(
  "dispatch:preferredIde",
  "vscode"
);

// Per-cwd preferences for the Create Agent dialog. Each cwd gets its own
// atom backed by localStorage; the family caches them by trimmed cwd.
export const createNewBranchPrefAtom = atomFamily((cwd: string) =>
  atomWithLocalStorage<boolean>(`dispatch:createNewBranch:${cwd}`, true)
);
