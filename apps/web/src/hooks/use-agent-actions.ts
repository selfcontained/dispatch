import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { type Agent } from "@/components/app/types";
import { type AgentType } from "@/lib/agent-types";
import { agentRoute } from "@/lib/agent-routes";
import { api } from "@/lib/api";
import { sortAgentsByCreatedAtDesc } from "@/lib/agent-sort";

type UseAgentActionsParams = {
  routeAgentId: string | undefined;
  setExpandedAgentId: React.Dispatch<React.SetStateAction<string | null>>;
  setCreateOpen: (open: boolean) => void;
  setRequestedCreateType: (type: AgentType | null) => void;
  setLastUsedAgentType: (type: AgentType) => void;
  refreshFiles: (agentId: string) => void;
};

export function useAgentActions({
  routeAgentId,
  setExpandedAgentId,
  setCreateOpen,
  setRequestedCreateType,
  setLastUsedAgentType,
  refreshFiles,
}: UseAgentActionsParams) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const ensureAuxExpanded = useCallback(
    (agentId: string) => {
      setExpandedAgentId(agentId);
    },
    [setExpandedAgentId]
  );

  const openAgent = useCallback(
    async (agent: Agent) => {
      navigate(agentRoute(agent.id));
      ensureAuxExpanded(agent.parentAgentId ?? agent.id);
      refreshFiles(agent.id);
    },
    [ensureAuxExpanded, navigate, refreshFiles]
  );

  const startAgent = useCallback(
    async (agent: Agent) => {
      navigate(agentRoute(agent.id));
      ensureAuxExpanded(agent.parentAgentId ?? agent.id);
      await api(`/api/v1/agents/${agent.id}/start`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      refreshFiles(agent.id);
    },
    [ensureAuxExpanded, navigate, refreshFiles]
  );

  const closeAgentAndClearSelection = useCallback(() => {
    navigate("/agents");
  }, [navigate]);

  // A stopped agent's Chat stays readable, so stopping never leaves the
  // route.
  const stopAgent = useCallback(async (agent: Agent) => {
    await api(`/api/v1/agents/${agent.id}/stop`, {
      method: "POST",
      body: JSON.stringify({ force: false }),
    });
  }, []);

  const deleteAgent = useCallback(
    async (agent: Agent, cleanupWorktree?: string) => {
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
    [navigate, routeAgentId, setExpandedAgentId]
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
        // Startup events can reach the cache before the create response.
        // That response is the original "creating" snapshot; replacing a
        // live entry with it strands the composer in its disabled state.
        return old;
      });
      navigate(agentRoute(agent.id));
      ensureAuxExpanded(agent.id);
      refreshFiles(agent.id);
    },
    [
      ensureAuxExpanded,
      navigate,
      queryClient,
      refreshFiles,
      setCreateOpen,
      setRequestedCreateType,
      setLastUsedAgentType,
    ]
  );

  return {
    openAgent,
    startAgent,
    stopAgent,
    deleteAgent,
    handleAgentCreated,
    closeAgentAndClearSelection,
    ensureAuxExpanded,
  };
}
