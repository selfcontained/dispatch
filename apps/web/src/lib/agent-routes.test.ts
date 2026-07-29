import { describe, expect, it } from "vitest";

import {
  agentChangesRoute,
  agentRoute,
  agentWhiteboardRoute,
} from "./agent-routes";

// These helpers are the single source of truth for agent URLs shared between
// the router config in App.tsx, the useMatch patterns in
// use-agents-view-routing.ts, and every navigate() call site. The literal
// paths are the contract.
describe("agent route helpers", () => {
  it("builds the three agent paths from the agent id", () => {
    expect(agentRoute("agt_123")).toBe("/agents/agt_123");
    expect(agentChangesRoute("agt_123")).toBe("/agents/agt_123/changes");
    expect(agentWhiteboardRoute("agt_123")).toBe("/agents/agt_123/whiteboard");
  });
});
