import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtom } from "jotai";

import { type AgentType, isAgentType } from "@/lib/agent-types";
import { api } from "@/lib/api";
import {
  createAgentModelPrefAtom,
  createBaseBranchPrefAtom,
  createFullAccessPrefAtom,
  createNewBranchPrefAtom,
  createUseWorktreePrefAtom,
} from "@/lib/store";

export const LAST_USED_CWD_KEY = "dispatch:lastUsedAgentCwd";
export const LAST_USED_TYPE_KEY = "dispatch:lastUsedAgentType";
export const CWD_HISTORY_KEY = "dispatch:cwdHistory";
export const CWD_HISTORY_USAGE_KEY = "dispatch:cwdHistoryUsage";
export const CWD_HISTORY_MAX = 20;
export const CONTEXT_PROMPT_ID = "create-agent-context-prompt";

type ProjectHistoryOption = {
  path: string;
  usageCount: number;
  latestCreatedAt: string;
  iconUrl?: string;
};

export function readStoredString(key: string): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(key)?.trim() ?? "";
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

export function readCwdHistoryUsage(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CWD_HISTORY_USAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[0] === "string" &&
          typeof entry[1] === "number" &&
          Number.isFinite(entry[1]) &&
          entry[1] > 0
      )
    );
  } catch {
    return {};
  }
}

function writeCwdHistory(nextHistory: string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CWD_HISTORY_KEY, JSON.stringify(nextHistory));
}

function writeCwdHistoryUsage(nextUsage: Record<string, number>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CWD_HISTORY_USAGE_KEY, JSON.stringify(nextUsage));
}

export function addToCwdHistory(cwd: string): string[] {
  const trimmed = cwd.trim();
  if (!trimmed) return readCwdHistory();
  const usage = readCwdHistoryUsage();
  usage[trimmed] = (usage[trimmed] ?? 0) + 1;
  const existing = readCwdHistory().filter((entry) => entry !== trimmed);
  const updated = [trimmed, ...existing].slice(0, CWD_HISTORY_MAX);
  const nextUsage = Object.fromEntries(
    updated.map((entry) => [entry, usage[entry] ?? 1])
  );
  writeCwdHistory(updated);
  writeCwdHistoryUsage(nextUsage);
  return updated;
}

export function removeCwdFromHistory(cwd: string): string[] {
  const next = readCwdHistory().filter((entry) => entry !== cwd);
  const usage = readCwdHistoryUsage();
  delete usage[cwd];
  writeCwdHistory(next);
  writeCwdHistoryUsage(usage);
  return next;
}

export function useCwdHistory() {
  const [history, setHistory] = useState<string[]>(() => readCwdHistory());
  const [usage, setUsage] = useState<Record<string, number>>(() =>
    readCwdHistoryUsage()
  );
  const { data: projectOptions = [] } = useQuery<ProjectHistoryOption[]>({
    queryKey: ["history", "projects", "cwd-suggestions"],
    queryFn: async () => {
      const payload = await api<{
        projectOptions?: ProjectHistoryOption[];
        projects: string[];
      }>("/api/v1/history/projects?limit=50");

      return (
        payload.projectOptions ??
        payload.projects.map((path) => ({
          path,
          usageCount: 0,
          latestCreatedAt: "",
        }))
      );
    },
    staleTime: 60_000,
  });

  const apiHistory = useMemo(
    () => projectOptions.map((option) => option.path),
    [projectOptions]
  );

  const historyMetadata = useMemo(
    () => ({
      ...Object.fromEntries(
        history.map((cwd) => [cwd, { usageCount: usage[cwd] ?? 0 }])
      ),
      ...Object.fromEntries(
        projectOptions.map((option) => [
          option.path,
          {
            usageCount: Math.max(option.usageCount, usage[option.path] ?? 0),
            iconUrl: option.iconUrl,
          },
        ])
      ),
    }),
    [history, projectOptions, usage]
  );

  const mergedHistory = useMemo(
    () => Array.from(new Set([...apiHistory, ...history])),
    [apiHistory, history]
  );

  const refresh = useCallback(() => {
    setHistory(readCwdHistory());
    setUsage(readCwdHistoryUsage());
  }, []);

  const add = useCallback(
    (cwd: string) => {
      addToCwdHistory(cwd);
      refresh();
    },
    [refresh]
  );

  const remove = useCallback(
    (cwd: string) => {
      removeCwdFromHistory(cwd);
      refresh();
    },
    [refresh]
  );

  return {
    history: mergedHistory,
    removableHistory: history,
    historyMetadata,
    add,
    remove,
    refresh,
  };
}

export function useCreateAgentPrefs(cwd: string, agentType: AgentType) {
  const trimmedCwd = cwd.trim();
  const [fullAccess, setFullAccess] = useAtom(
    useMemo(() => createFullAccessPrefAtom(trimmedCwd), [trimmedCwd])
  );
  const [baseBranch, setBaseBranch] = useAtom(
    useMemo(() => createBaseBranchPrefAtom(trimmedCwd), [trimmedCwd])
  );
  const [useWorktree, setUseWorktree] = useAtom(
    useMemo(() => createUseWorktreePrefAtom(trimmedCwd), [trimmedCwd])
  );

  const createNewBranchAtom = useMemo(
    () => createNewBranchPrefAtom(trimmedCwd),
    [trimmedCwd]
  );
  const [createNewBranch, setCreateNewBranch] = useAtom(createNewBranchAtom);
  const modelAtom = useMemo(
    () => createAgentModelPrefAtom(`${agentType}:${trimmedCwd}`),
    [agentType, trimmedCwd]
  );
  const [model, setModel] = useAtom(modelAtom);

  return {
    fullAccess,
    setFullAccess,
    baseBranch,
    setBaseBranch,
    useWorktree,
    setUseWorktree,
    createNewBranch,
    setCreateNewBranch,
    model,
    setModel,
  };
}
