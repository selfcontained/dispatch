import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Agent, type AgentVisualState } from "@/components/app/types";
import { sortAgentsByCreatedAtDesc } from "@/lib/agent-sort";
import { api } from "@/lib/api";

export function useAgents(enabled: boolean, selectedAgentId: string | null) {
  const queryClient = useQueryClient();

  const [overflowAgentId, setOverflowAgentId] = useState<string | null>(null);

  const { data: agents = [], isSuccess: agentsLoaded } = useQuery<Agent[]>({
    queryKey: ["agents"],
    queryFn: async () => {
      const payload = await api<{ agents: Agent[] }>("/api/v1/agents");
      return payload.agents;
    },
    select: (data) => sortAgentsByCreatedAtDesc(data),
    enabled,
    refetchOnWindowFocus: false,
  });

  // Re-sort agents in query cache.
  const resortAgents = useCallback(() => {
    queryClient.setQueryData<Agent[]>(["agents"], (old) =>
      old ? sortAgentsByCreatedAtDesc(old) : old
    );
  }, [queryClient]);

  // Validate selectedAgentId against current agent list.
  const validatedSelectedAgentId = useMemo(() => {
    if (selectedAgentId && agents.some((a) => a.id === selectedAgentId)) {
      return selectedAgentId;
    }
    return null;
  }, [agents, selectedAgentId]);

  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === validatedSelectedAgentId) ?? null,
    [agents, validatedSelectedAgentId]
  );

  const agentVisualState = useCallback(
    (agent: Agent): AgentVisualState => {
      if (agent.status !== "running" && agent.status !== "creating")
        return "stopped";
      if (validatedSelectedAgentId === agent.id) return "active";
      return "idle";
    },
    [validatedSelectedAgentId]
  );

  return useMemo(
    () => ({
      agents,
      agentsLoaded,
      validatedSelectedAgentId,
      selectedAgent,
      overflowAgentId,
      setOverflowAgentId,
      agentVisualState,
      resortAgents,
    }),
    [
      agents,
      agentsLoaded,
      validatedSelectedAgentId,
      selectedAgent,
      overflowAgentId,
      agentVisualState,
      resortAgents,
    ]
  );
}
