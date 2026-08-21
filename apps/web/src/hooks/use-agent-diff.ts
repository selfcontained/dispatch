import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";

// The diff shapes are defined once on the server and imported type-only —
// esbuild erases these imports, so nothing from the server reaches the web
// bundle.
import type {
  DiffFile,
  DiffFileStatus,
  DiffResponse as AgentDiffResult,
  FileDiffResponse,
} from "../../../server/src/shared/git/agent-diff";

import { api } from "@/lib/api";
import { diffIncludeUncommittedAtom } from "@/lib/store";

export type { DiffFile, DiffFileStatus, FileDiffResponse };

/**
 * Wire shape of GET /api/v1/agents/:id/diff. The server's own DiffResponse
 * always carries a merge-base SHA, but the route substitutes
 * `{ baseRef: null, files: [] }` when the diff cannot be computed, so baseRef
 * is nullable over the wire.
 */
export type DiffResponse = Omit<AgentDiffResult, "baseRef"> & {
  baseRef: string | null;
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
  const includeUncommitted = useAtomValue(diffIncludeUncommittedAtom);

  const query = useQuery<DiffResponse>({
    queryKey: [
      ...agentDiffQueryKey(agentId ?? ""),
      ignoreWhitespace,
      includeUncommitted,
    ],
    queryFn: async () => {
      return api<DiffResponse>(
        `/api/v1/agents/${agentId}/diff?ignoreWhitespace=${ignoreWhitespace}&includeUncommitted=${includeUncommitted}`
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
  const includeUncommitted = useAtomValue(diffIncludeUncommittedAtom);
  const query = useQuery<FileDiffResponse>({
    queryKey: [
      "agent-diff-file",
      agentId,
      filePath,
      ignoreWhitespace,
      includeUncommitted,
    ],
    queryFn: async () => {
      return api<FileDiffResponse>(
        `/api/v1/agents/${agentId}/diff/file?path=${encodeURIComponent(filePath!)}&force=true&ignoreWhitespace=${ignoreWhitespace}&includeUncommitted=${includeUncommitted}`
      );
    },
    enabled: enabled && !!agentId && !!filePath,
    staleTime: 10_000,
  });

  return { data: query.data, isLoading: query.isLoading };
}
