import { useCallback } from "react";
import { useAtom } from "jotai";

import { agentSupportsHarness } from "@/lib/center-tabs";
import {
  type AgentPaneView,
  agentPaneViewAtomFamily,
  defaultAgentPaneView,
  inactiveAgentPaneViewAtom,
  isAgentPaneView,
} from "@/lib/store";

/**
 * Which of Harness / Chat / Console the Agent pane shows for `agentId`,
 * remembered per agent across reloads. Defaults per agent type (see
 * `defaultAgentPaneView`). With no agent in focus the value is an
 * unpersisted placeholder so nothing is written under a bogus key.
 */
export function useAgentPaneView(
  agentId: string | null,
  agentType?: string | null
): [AgentPaneView, (view: AgentPaneView) => void] {
  const [stored, setStored] = useAtom(
    agentId ? agentPaneViewAtomFamily(agentId) : inactiveAgentPaneViewAtom
  );
  // Stored values are user-editable localStorage; anything else reads as
  // the default rather than as a view nothing renders.
  // "harness" stored for an agent that cannot render it (a type change is
  // impossible, but storage is user-editable) falls back the same way.
  const harness = agentSupportsHarness(agentType);
  const view: AgentPaneView =
    isAgentPaneView(stored) &&
    (stored !== "harness" || harness) &&
    // A harness agent has no Chat view; its stored "chat" reads as Harness.
    (stored !== "chat" || !harness)
      ? stored
      : defaultAgentPaneView(agentType);
  const setView = useCallback(
    (next: AgentPaneView) => setStored(next),
    [setStored]
  );
  return [view, setView];
}
