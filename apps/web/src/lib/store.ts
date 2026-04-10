import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { FeedbackDetailState } from "@/components/app/feedback-panel";

function atomWithLocalStorage<T>(key: string, initialValue: T) {
  const baseAtom = atom<T>((() => {
    if (typeof window === "undefined") return initialValue;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === null) return initialValue;
      return JSON.parse(stored) as T;
    } catch {
      return initialValue;
    }
  })());

  const derivedAtom = atom(
    (get) => get(baseAtom),
    (_get, set, update: T | ((prev: T) => T)) => {
      const nextValue = typeof update === "function" ? (update as (prev: T) => T)(_get(baseAtom)) : update;
      set(baseAtom, nextValue);
      window.localStorage.setItem(key, JSON.stringify(nextValue));
    }
  );

  return derivedAtom;
}

export const leftSidebarOpenAtom = atomWithLocalStorage("dispatch:leftSidebarOpen", true);
export const mediaSidebarOpenAtom = atomWithLocalStorage("dispatch:mediaSidebarOpen", false);
export const mediaSidebarTabAtom = atomWithLocalStorage<"pins" | "media">("dispatch:mediaSidebarTab", "pins");
export const feedbackDetailAtom = atomWithLocalStorage<FeedbackDetailState>("dispatch:feedbackDetail", null);
export const expandedAgentIdAtom = atomWithLocalStorage<string | null>("dispatch:expandedAgentId", null);

/** Per-directory full-access mode preference, backed by localStorage (sync read). */
export const fullAccessByCwdAtom = atomFamily((cwd: string) =>
  atomWithLocalStorage(`dispatch:fullAccess:${cwd}`, false),
);

/** Per-directory last-used base branch, backed by localStorage (sync read). */
export const baseBranchByCwdAtom = atomFamily((cwd: string) =>
  atomWithLocalStorage(`dispatch:baseBranch:${cwd}`, "main"),
);
