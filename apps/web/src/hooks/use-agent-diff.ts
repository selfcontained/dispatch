import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed";

export type DiffFile = {
  path: string;
  status: DiffFileStatus;
  oldPath?: string;
  added: number;
  deleted: number;
  diff: string | null;
  truncated: boolean;
};

export type DiffResponse = {
  baseRef: string | null;
  files: DiffFile[];
};

export type FileDiffResponse = {
  path: string;
  status: DiffFileStatus;
  oldPath?: string;
  added: number;
  deleted: number;
  diff: string;
};

export function agentDiffQueryKey(agentId: string): [string, string] {
  return ["agent-diff-content", agentId];
}

export function useAgentDiff(
  agentId: string | null,
  enabled: boolean,
  ignoreWhitespace = true
): {
  data: DiffResponse | undefined;
  isLoading: boolean;
  refresh: () => void;
} {
  const queryClient = useQueryClient();

  const query = useQuery<DiffResponse>({
    queryKey: [...agentDiffQueryKey(agentId ?? ""), ignoreWhitespace],
    queryFn: async () => {
      return api<DiffResponse>(
        `/api/v1/agents/${agentId}/diff?ignoreWhitespace=${ignoreWhitespace}`
      );
    },
    enabled: enabled && !!agentId,
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });

  const refresh = useCallback(() => {
    if (agentId) {
      void queryClient.invalidateQueries({
        queryKey: agentDiffQueryKey(agentId),
      });
    }
  }, [agentId, queryClient]);

  return { data: query.data, isLoading: query.isLoading, refresh };
}

export function useAgentFileDiff(
  agentId: string | null,
  filePath: string | null,
  enabled: boolean,
  ignoreWhitespace = true
): {
  data: FileDiffResponse | undefined;
  isLoading: boolean;
} {
  const query = useQuery<FileDiffResponse>({
    queryKey: ["agent-diff-file", agentId, filePath, ignoreWhitespace],
    queryFn: async () => {
      return api<FileDiffResponse>(
        `/api/v1/agents/${agentId}/diff/file?path=${encodeURIComponent(filePath!)}&force=true&ignoreWhitespace=${ignoreWhitespace}`
      );
    },
    enabled: enabled && !!agentId && !!filePath,
    staleTime: 10_000,
  });

  return { data: query.data, isLoading: query.isLoading };
}
