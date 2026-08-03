import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  EXPANDED_AGENT_ID_KEY,
  readExpandedAgentId,
} from "@/components/app/agents-view-utils";
import { type Agent } from "@/components/app/types";
import { isNestedReviewAgent } from "@/lib/agent-types";

/**
 * Owns which agent card is expanded in the sidebar: localStorage-initialized
 * state and a toggle. The persistence and selection-follow effects live in
 * `useExpandedAgentSync` so callers can register them at a specific point in
 * their effect order.
 */
export function useExpandedAgent() {
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(() =>
    readExpandedAgentId()
  );

  const toggleAgentDetails = useCallback((agentId: string) => {
    setExpandedAgentId((current) => (current === agentId ? null : agentId));
  }, []);

  return { expandedAgentId, setExpandedAgentId, toggleAgentDetails };
}

/**
 * Registers the expanded-agent side effects: persisting the expanded card to
 * localStorage, and following the selected agent (resolving nested review
 * agents to their parent so the parent card expands). Split from
 * `useExpandedAgent` so the effects register at the same position in the
 * caller's effect sequence as before the extraction — React runs passive
 * effects in declaration order, and this call site sits among other effects
 * whose relative timing should not change.
 */
export function useExpandedAgentSync(
  agents: Agent[],
  validatedSelectedAgentId: string | null,
  expandedAgentId: string | null,
  setExpandedAgentId: Dispatch<SetStateAction<string | null>>
) {
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
  }, [selectedExpansionTarget, setExpandedAgentId]);
}
