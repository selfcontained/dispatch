import { createContext, useContext } from "react";

/**
 * The agent whose stream is on screen, for renderers deep in the rail
 * (a subagent step fetches its child's log by agent id) without threading
 * the id through every primitive.
 */
export const HarnessAgentContext = createContext<string | null>(null);

export function useHarnessAgentId(): string | null {
  return useContext(HarnessAgentContext);
}
