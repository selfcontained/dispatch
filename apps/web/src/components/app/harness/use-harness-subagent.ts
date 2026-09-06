import { useQuery } from "@tanstack/react-query";
import type {
  HarnessSubagent,
  HarnessSubagentResponse,
} from "@dispatch/shared";

import { api } from "@/lib/api";

export function harnessSubagentQueryKey(
  agentId: string | null,
  sessionId: string | null
) {
  return ["harness-subagent", agentId, sessionId] as const;
}

/**
 * A subagent's shaped log. It has no stream of its own into Dispatch, so
 * while it runs this polls the file; once finished the answer is final.
 */
export function useHarnessSubagent(
  agentId: string | null,
  sessionId: string | null
): {
  subagent: HarnessSubagent | null;
  loading: boolean;
  error: Error | null;
} {
  const query = useQuery({
    queryKey: harnessSubagentQueryKey(agentId, sessionId),
    queryFn: () =>
      api<HarnessSubagentResponse>(
        `/api/v1/agents/${agentId}/harness/subagents/${sessionId}`
      ),
    enabled: agentId !== null && sessionId !== null,
    staleTime: 2_000,
    refetchInterval: (q) =>
      q.state.data?.subagent.status === "finished" ? false : 3_000,
  });
  return {
    subagent: query.data?.subagent ?? null,
    loading: query.isLoading,
    error: query.error,
  };
}
