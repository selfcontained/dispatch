import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { type Agent } from "@/components/app/types";
import { type AgentType } from "@/lib/agent-types";
import { agentRoute } from "@/lib/agent-routes";
import { api } from "@/lib/api";
import { sortAgentsByCreatedAtDesc } from "@/lib/agent-sort";

type UseAgentActionsParams = {
  connectedAgentId: string | null;
  routeAgentId: string | undefined;
  setExpandedAgentId: React.Dispatch<React.SetStateAction<string | null>>;
  setCreateOpen: (open: boolean) => void;
  setRequestedCreateType: (type: AgentType | null) => void;
  setLastUsedAgentType: (type: AgentType) => void;
  ensureTerminalConnected: (
    autoAttach: boolean,
    force: boolean,
    agentId: string
  ) => Promise<void>;
  detachTerminal: () => void;
  refreshMedia: (agentId: string) => void;
};

export function useAgentActions({
  connectedAgentId,
  routeAgentId,
  setExpandedAgentId,
  setCreateOpen,
  setRequestedCreateType,
  setLastUsedAgentType,
  ensureTerminalConnected,
  detachTerminal,
  refreshMedia,
}: UseAgentActionsParams) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const ensureAuxExpanded = useCallback(
    (agentId: string) => {
      setExpandedAgentId(agentId);
    },
    [setExpandedAgentId]
  );

  const attachToAgent = useCallback(
    async (agent: Agent) => {
      navigate(agentRoute(agent.id));
      ensureAuxExpanded(agent.parentAgentId ?? agent.id);
      refreshMedia(agent.id);
      await ensureTerminalConnected(true, true, agent.id);
    },
    [ensureAuxExpanded, ensureTerminalConnected, navigate, refreshMedia]
  );

  const startAgent = useCallback(
    async (agent: Agent) => {
      navigate(agentRoute(agent.id));
      ensureAuxExpanded(agent.parentAgentId ?? agent.id);
      await api(`/api/v1/agents/${agent.id}/start`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      refreshMedia(agent.id);
      await ensureTerminalConnected(true, true, agent.id);
    },
    [ensureAuxExpanded, ensureTerminalConnected, navigate, refreshMedia]
  );

  const detachAndClearSelection = useCallback(() => {
    detachTerminal();
    navigate("/agents");
  }, [detachTerminal, navigate]);

  const stopAgent = useCallback(
    async (agent: Agent) => {
      if (connectedAgentId === agent.id) {
        detachAndClearSelection();
      }
      await api(`/api/v1/agents/${agent.id}/stop`, {
        method: "POST",
        body: JSON.stringify({ force: false }),
      });
    },
    [connectedAgentId, detachAndClearSelection]
  );

  const deleteAgent = useCallback(
    async (agent: Agent, cleanupWorktree?: string) => {
      if (connectedAgentId === agent.id) {
        detachTerminal();
      }
      setExpandedAgentId((current) => (current === agent.id ? null : current));
      if (routeAgentId === agent.id) {
        navigate("/agents", { replace: true });
      }
      const searchParams = new URLSearchParams();
      if (cleanupWorktree) {
        searchParams.set("cleanupWorktree", cleanupWorktree);
      }
      const qs = searchParams.toString();
      await api(`/api/v1/agents/${agent.id}${qs ? `?${qs}` : ""}`, {
        method: "DELETE",
      });
    },
    [
      connectedAgentId,
      detachTerminal,
      navigate,
      routeAgentId,
      setExpandedAgentId,
    ]
  );

  const handleAgentCreated = useCallback(
    async (agent: Agent, agentType: AgentType) => {
      setCreateOpen(false);
      setRequestedCreateType(null);
      setLastUsedAgentType(agentType);
      queryClient.setQueryData<Agent[]>(["agents"], (old) => {
        if (!old) return [agent];
        const index = old.findIndex((a) => a.id === agent.id);
        if (index === -1) {
          return sortAgentsByCreatedAtDesc([agent, ...old]);
        }
        const next = [...old];
        next[index] = agent;
        return sortAgentsByCreatedAtDesc(next);
      });
      navigate(agentRoute(agent.id));
      ensureAuxExpanded(agent.id);
      refreshMedia(agent.id);
      await ensureTerminalConnected(true, true, agent.id);
    },
    [
      ensureAuxExpanded,
      ensureTerminalConnected,
      navigate,
      queryClient,
      refreshMedia,
      setCreateOpen,
      setRequestedCreateType,
      setLastUsedAgentType,
    ]
  );

  return {
    attachToAgent,
    startAgent,
    stopAgent,
    deleteAgent,
    handleAgentCreated,
    detachAndClearSelection,
    ensureAuxExpanded,
  };
}
