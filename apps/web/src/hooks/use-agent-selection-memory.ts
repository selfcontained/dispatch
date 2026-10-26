import { useLocation } from "react-router-dom";
import { useEffect } from "react";
import { useAtom } from "jotai";
import type { Agent } from "@/components/app/types";
import { isAgentInScope } from "@/lib/agent-selection";
import { lastAgentIdAtomFamily } from "@/lib/store";

/** Observe explicit URL selection; never select an agent on mount/history. */
export function useAgentSelectionMemory({
  projectId,
  agents,
  agentsLoaded,
  selectedAgentId,
}: {
  projectId: string | null;
  agents: Agent[];
  agentsLoaded: boolean;
  selectedAgentId: string | null;
}) {
  const { state } = useLocation();
  const [rememberedId, remember] = useAtom(lastAgentIdAtomFamily(projectId));
  // Selection is already validated by the view. Keep this effect independent
  // of memory updates so an explicit Close cannot re-save the old selection.
  useEffect(() => {
    if (agentsLoaded && selectedAgentId && !state?.dispatchProjectSwitch) {
      remember(selectedAgentId);
    }
  }, [agentsLoaded, projectId, remember, selectedAgentId, state]);

  useEffect(() => {
    if (!agentsLoaded || !rememberedId) return;
    if (
      !agents.some(
        (agent) => agent.id === rememberedId && isAgentInScope(agent, projectId)
      )
    ) {
      // A valid URL may have just replaced a stale memory in the effect
      // above. Recheck the current value before clearing that newer choice.
      remember((current) =>
        current &&
        agents.some(
          (agent) => agent.id === current && isAgentInScope(agent, projectId)
        )
          ? current
          : null
      );
    }
  }, [agents, agentsLoaded, projectId, remember, rememberedId]);
}
