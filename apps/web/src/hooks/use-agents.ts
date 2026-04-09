import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type Agent,
  type AgentVisualState,
  type ConnState,
} from "@/components/app/types";
import { sortAgentsByCreatedAtDesc } from "@/lib/agent-sort";
import { api } from "@/lib/api";

export function useAgents(
  connectedAgentId: string | null,
  connState: ConnState,
  enabled: boolean,
  selectedAgentId: string | null,
) {
  const queryClient = useQueryClient();
  const connectedAgentIdRef = useRef(connectedAgentId);
  connectedAgentIdRef.current = connectedAgentId;

  const [overflowAgentId, setOverflowAgentId] = useState<string | null>(null);
  const [streamingAgentIds, setStreamingAgentIds] = useState<Set<string>>(new Set());

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

  const connectedAgent = useMemo(
    () => agents.find((a) => a.id === connectedAgentId) ?? null,
    [agents, connectedAgentId]
  );

  const agentVisualState = useCallback(
    (agent: Agent): AgentVisualState => {
      if (agent.status === "creating") return "active";
      if (agent.status !== "running") return "stopped";
      if (connState === "connected" && connectedAgentId === agent.id) return "active";
      return "idle";
    },
    [connState, connectedAgentId]
  );

  return useMemo(() => ({
    agents,
    agentsLoaded,
    validatedSelectedAgentId,
    selectedAgent,
    connectedAgent,
    overflowAgentId,
    setOverflowAgentId,
    streamingAgentIds,
    setStreamingAgentIds,
    agentVisualState,
    resortAgents,
  }), [
    agents,
    agentsLoaded,
    validatedSelectedAgentId,
    selectedAgent,
    connectedAgent,
    overflowAgentId,
    streamingAgentIds,
    agentVisualState,
    resortAgents,
  ]);
}
