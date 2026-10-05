import { describe, expect, it } from "vitest";

import {
  agentChangesRoute,
  agentRoute,
  agentTurnLocation,
} from "./agent-routes";

// These helpers are the single source of truth for agent URLs shared between
// the router config in App.tsx, the useMatch patterns in
// use-agents-view-routing.ts, and every navigate() call site. The literal
// paths are the contract.
describe("agent route helpers", () => {
  it("builds the agent paths from the agent id", () => {
    expect(agentRoute("agt_123")).toBe("/agents/agt_123");
    expect(agentChangesRoute("agt_123")).toBe("/agents/agt_123/changes");
  });

  it("opens a turn in its owning stream, including a foreign thread", () => {
    expect(
      agentTurnLocation("agt_worker", {
        streamId: "agt_owner",
        blockId: "turn",
        threadId: "launch",
      })
    ).toEqual({
      pathname: "/agents/agt_owner",
      search: "?thread=launch&block=turn",
    });
    expect(
      agentTurnLocation("agt_worker", {
        streamId: "agt_owner",
        blockId: "turn",
        threadId: null,
      })
    ).toEqual({ pathname: "/agents/agt_owner", search: "?block=turn" });
  });

  it("falls back to the agent page for older turns without a stream id", () => {
    expect(
      agentTurnLocation("agt_worker", {
        blockId: "turn",
        threadId: "launch",
      })
    ).toEqual({
      pathname: "/agents/agt_worker",
      search: "?thread=launch&block=turn",
    });
  });

  it("keeps a child's own-lineage turn on its filtered page", () => {
    expect(
      agentTurnLocation(
        "agt_child",
        { streamId: "agt_root", blockId: "turn", threadId: "launch" },
        "agt_root"
      )
    ).toEqual({
      pathname: "/agents/agt_child",
      search: "?thread=launch&block=turn",
    });
    expect(
      agentTurnLocation(
        "agt_child",
        { streamId: "agt_foreign", blockId: "turn", threadId: "launch" },
        "agt_root"
      )
    ).toEqual({
      pathname: "/agents/agt_foreign",
      search: "?thread=launch&block=turn",
    });
  });

  it("keeps a root's own-stream turn on its page", () => {
    expect(
      agentTurnLocation("agt_root", {
        streamId: "agt_root",
        blockId: "turn",
        threadId: null,
      })
    ).toEqual({ pathname: "/agents/agt_root", search: "?block=turn" });
  });
});
