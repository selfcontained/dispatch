// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { viewingAgentIdOf } from "@/hooks/use-agent-focus";

import { attentionToastLocation } from "./attention-toast";

const base = {
  type: "attention.toast" as const,
  toastId: "t1",
  agentId: "agt_b",
  agentName: "Builder",
  message: "Ship it?",
};

describe("attentionToastLocation", () => {
  it("opens the question in its thread", () => {
    expect(
      attentionToastLocation({
        ...base,
        target: { streamId: "agt_b", threadId: "thr_1", blockId: "blk_1" },
      })
    ).toEqual({
      pathname: "/agents/agt_b",
      search: "?thread=thr_1&block=blk_1",
    });
  });

  it("opens the agent when there is no question", () => {
    expect(attentionToastLocation({ ...base, target: null })).toEqual({
      pathname: "/agents/agt_b",
      search: "",
    });
  });
});

describe("viewingAgentIdOf", () => {
  it("reads the agent from agent routes", () => {
    expect(viewingAgentIdOf("/agents/agt_a/changes")).toBe("agt_a");
    expect(viewingAgentIdOf("/activity/history/agt_a")).toBeNull();
    expect(viewingAgentIdOf("/tasks")).toBeNull();
    expect(viewingAgentIdOf("/agents/%E0%A4%A")).toBe("%E0%A4%A");
  });
});
