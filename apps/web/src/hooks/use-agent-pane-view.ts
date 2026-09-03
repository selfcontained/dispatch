import { useCallback } from "react";
import { useAtom } from "jotai";

import {
  type AgentPaneView,
  agentPaneViewAtomFamily,
  inactiveAgentPaneViewAtom,
  isAgentPaneView,
} from "@/lib/store";

/**
 * Which of Chat / Console the Agent pane shows for `agentId`, remembered per
 * agent across reloads. Defaults to Chat. With no agent in focus the value
 * is an unpersisted placeholder so nothing is written under a bogus key.
 */
export function useAgentPaneView(
  agentId: string | null
): [AgentPaneView, (view: AgentPaneView) => void] {
  const [stored, setStored] = useAtom(
    agentId ? agentPaneViewAtomFamily(agentId) : inactiveAgentPaneViewAtom
  );
  // Stored values are user-editable localStorage; anything else reads as
  // the default rather than as a view nothing renders.
  const view: AgentPaneView = isAgentPaneView(stored) ? stored : "chat";
  const setView = useCallback(
    (next: AgentPaneView) => setStored(next),
    [setStored]
  );
  return [view, setView];
}
