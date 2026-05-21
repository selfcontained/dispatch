import { useEffect, useMemo, useState } from "react";
import { useAtom } from "jotai";

import { type AgentType, isAgentType } from "@/lib/agent-types";
import { createNewBranchPrefAtom } from "@/lib/store";

export const LAST_USED_CWD_KEY = "dispatch:lastUsedAgentCwd";
export const LAST_USED_TYPE_KEY = "dispatch:lastUsedAgentType";
export const CWD_HISTORY_KEY = "dispatch:cwdHistory";
export const CWD_HISTORY_MAX = 20;
export const FULL_ACCESS_PREFIX = "dispatch:fullAccess:";
export const AUTO_REVIEW_PREFIX = "dispatch:autoReview:";
export const BASE_BRANCH_PREFIX = "dispatch:baseBranch:";
export const CONTEXT_PROMPT_ID = "create-agent-context-prompt";

export function readStoredString(key: string): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(key)?.trim() ?? "";
}

export function readStoredBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(key);
  if (value === null) return fallback;
  return value === "true";
}

export function readLastUsedCwd(): string {
  return readStoredString(LAST_USED_CWD_KEY) || "~/";
}

export function readLastUsedAgentType(): AgentType | null {
  const stored = readStoredString(LAST_USED_TYPE_KEY);
  return stored && isAgentType(stored) ? stored : null;
}

export function readCwdHistory(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CWD_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
  } catch {
    return [];
  }
}

function writeCwdHistory(nextHistory: string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CWD_HISTORY_KEY, JSON.stringify(nextHistory));
}

export function addToCwdHistory(cwd: string): string[] {
  const trimmed = cwd.trim();
  if (!trimmed) return readCwdHistory();
  const existing = readCwdHistory().filter((entry) => entry !== trimmed);
  const updated = [trimmed, ...existing].slice(0, CWD_HISTORY_MAX);
  writeCwdHistory(updated);
  return updated;
}

export function removeCwdFromHistory(cwd: string): string[] {
  const next = readCwdHistory().filter((entry) => entry !== cwd);
  writeCwdHistory(next);
  return next;
}

export function useCreateAgentPrefs(cwd: string) {
  const trimmedCwd = cwd.trim();
  const [fullAccess, setFullAccess] = useState(false);
  const [autoReview, setAutoReview] = useState(false);
  const [baseBranch, setBaseBranch] = useState("main");

  const createNewBranchAtom = useMemo(
    () => createNewBranchPrefAtom(trimmedCwd),
    [trimmedCwd]
  );
  const [createNewBranch, setCreateNewBranch] = useAtom(createNewBranchAtom);

  useEffect(() => {
    if (!trimmedCwd) {
      setFullAccess(false);
      setAutoReview(false);
      setBaseBranch("main");
      return;
    }
    setFullAccess(
      readStoredBoolean(`${FULL_ACCESS_PREFIX}${trimmedCwd}`, false)
    );
    setAutoReview(
      readStoredBoolean(`${AUTO_REVIEW_PREFIX}${trimmedCwd}`, false)
    );
    setBaseBranch(
      readStoredString(`${BASE_BRANCH_PREFIX}${trimmedCwd}`) || "main"
    );
  }, [trimmedCwd]);

  useEffect(() => {
    if (!trimmedCwd || typeof window === "undefined") return;
    window.localStorage.setItem(
      `${FULL_ACCESS_PREFIX}${trimmedCwd}`,
      String(fullAccess)
    );
  }, [fullAccess, trimmedCwd]);

  useEffect(() => {
    if (!trimmedCwd || typeof window === "undefined") return;
    window.localStorage.setItem(
      `${AUTO_REVIEW_PREFIX}${trimmedCwd}`,
      String(autoReview)
    );
  }, [autoReview, trimmedCwd]);

  useEffect(() => {
    if (!trimmedCwd || typeof window === "undefined") return;
    window.localStorage.setItem(
      `${BASE_BRANCH_PREFIX}${trimmedCwd}`,
      baseBranch
    );
  }, [baseBranch, trimmedCwd]);

  return {
    fullAccess,
    setFullAccess,
    autoReview,
    setAutoReview,
    baseBranch,
    setBaseBranch,
    createNewBranch,
    setCreateNewBranch,
  };
}
