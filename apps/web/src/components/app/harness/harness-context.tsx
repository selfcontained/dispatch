import { createContext, useContext } from "react";

export type HarnessContextValue = {
  /** The agent whose stream is on screen. */
  agentId: string | null;
  /** A turn is running: nested views keep polling; settled ones stop. */
  live: boolean;
};

/**
 * What renderers deep in the rail need without threading props through
 * every primitive: a subagent step fetches its child's log by agent id,
 * and polls it only while the parent turn is still running.
 */
export const HarnessContext = createContext<HarnessContextValue>({
  agentId: null,
  live: false,
});

export function useHarnessContext(): HarnessContextValue {
  return useContext(HarnessContext);
}
