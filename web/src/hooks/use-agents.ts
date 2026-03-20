import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type Agent,
  type AgentVisualState,
  type ConnState,
} from "@/components/app/types";
import { api } from "@/lib/api";

function sortAgentsByCreatedAtDesc(items: Agent[], activeAgentId?: string | null): Agent[] {
  const eventPriority = (agent: Agent): number => {
    if (activeAgentId && agent.id === activeAgentId) return -1;
    if (agent.latestEvent?.type === "blocked") return 0;
    if (agent.latestEvent?.type === "waiting_user") return 1;
    if (agent.status === "running" || agent.status === "creating" || agent.status === "stopping") return 2;
    return 3;
  };

  const latestActivityAt = (agent: Agent): string =>
    agent.latestEvent?.updatedAt ?? agent.updatedAt ?? agent.createdAt;

  return [...items].sort((a, b) => {
    const priorityDelta = eventPriority(a) - eventPriority(b);
    if (priorityDelta !== 0) return priorityDelta;
    return latestActivityAt(b).localeCompare(latestActivityAt(a));
  });
}

export { sortAgentsByCreatedAtDesc };

export function useAgents(
  connectedAgentId: string | null,
  connState: ConnState,
  enabled: boolean,
) {
  const queryClient = useQueryClient();
  const connectedAgentIdRef = useRef(connectedAgentId);
  connectedAgentIdRef.current = connectedAgentId;

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [overflowAgentId, setOverflowAgentId] = useState<string | null>(null);
  const [streamingAgentIds, setStreamingAgentIds] = useState<Set<string>>(new Set());

  const { data: agents = [], isSuccess: agentsLoaded } = useQuery<Agent[]>({
    queryKey: ["agents"],
    queryFn: async () => {
      const payload = await api<{ agents: Agent[] }>("/api/v1/agents");
      return payload.agents;
    },
    select: (data) => sortAgentsByCreatedAtDesc(data, connectedAgentIdRef.current),
    enabled,
  });

  // Re-sort when connected agent changes (so it floats to top).
  const resortAgents = useCallback(() => {
    queryClient.setQueryData<Agent[]>(["agents"], (old) =>
      old ? sortAgentsByCreatedAtDesc(old, connectedAgentIdRef.current) : old
    );
  }, [queryClient]);

  // Validate selectedAgentId against current agent list.
  const validatedSelectedAgentId = useMemo(() => {
    if (selectedAgentId && agents.some((a) => a.id === selectedAgentId)) {
      return selectedAgentId;
    }
    return null;
  }, [agents, selectedAgentId]);

  // If validation changed the value, sync local state.
  if (validatedSelectedAgentId !== selectedAgentId) {
    setSelectedAgentId(validatedSelectedAgentId);
  }

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
      if (agent.status !== "running") return "stopped";
      if (connState === "connected" && connectedAgentId === agent.id) return "active";
      return "idle";
    },
    [connState, connectedAgentId]
  );

  return {
    agents,
    agentsLoaded,
    selectedAgentId: validatedSelectedAgentId,
    setSelectedAgentId,
    selectedAgent,
    connectedAgent,
    overflowAgentId,
    setOverflowAgentId,
    streamingAgentIds,
    setStreamingAgentIds,
    agentVisualState,
    resortAgents,
  };
}
