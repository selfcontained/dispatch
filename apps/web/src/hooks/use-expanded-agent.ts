import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  EXPANDED_AGENT_ID_KEY,
  readExpandedAgentId,
} from "@/components/app/agents-view-utils";
import { type Agent } from "@/components/app/types";
import { isNestedReviewAgent } from "@/lib/agent-types";

/**
 * Owns which agent card is expanded in the sidebar: localStorage-persisted
 * state, a toggle, and an effect that follows the selected agent (resolving
 * nested review agents to their parent so the parent card expands).
 */
export function useExpandedAgent(
  agents: Agent[],
  validatedSelectedAgentId: string | null
) {
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(() =>
    readExpandedAgentId()
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!expandedAgentId) {
      window.localStorage.removeItem(EXPANDED_AGENT_ID_KEY);
      return;
    }
    window.localStorage.setItem(EXPANDED_AGENT_ID_KEY, expandedAgentId);
  }, [expandedAgentId]);

  const selectedExpansionTarget = useMemo(() => {
    if (!validatedSelectedAgentId) return null;
    const selected = agents.find((a) => a.id === validatedSelectedAgentId);
    return selected && isNestedReviewAgent(selected)
      ? (selected.parentAgentId ?? validatedSelectedAgentId)
      : validatedSelectedAgentId;
  }, [agents, validatedSelectedAgentId]);
  const prevSelectedExpansionTargetRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedExpansionTarget) {
      prevSelectedExpansionTargetRef.current = null;
      return;
    }
    if (prevSelectedExpansionTargetRef.current === selectedExpansionTarget) {
      return;
    }
    prevSelectedExpansionTargetRef.current = selectedExpansionTarget;
    setExpandedAgentId((current) =>
      current === selectedExpansionTarget ? current : selectedExpansionTarget
    );
  }, [selectedExpansionTarget]);

  const toggleAgentDetails = useCallback((agentId: string) => {
    setExpandedAgentId((current) => (current === agentId ? null : agentId));
  }, []);

  return { expandedAgentId, setExpandedAgentId, toggleAgentDetails };
}
