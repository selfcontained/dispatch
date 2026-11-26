import { describe, expect, it } from "vitest";
import type { Agent } from "@/components/app/types";
import { isAgentInScope } from "./agent-selection";

const agent = (fields: Partial<Agent>) =>
  ({ status: "running", ...fields }) as Agent;

describe("isAgentInScope", () => {
  const parent = agent({ id: "agt_parent", projectId: "project-a" });
  // A child row left in another project when its parent moved.
  const child = agent({
    id: "agt_child",
    parentAgentId: "agt_parent",
    projectId: "project-b",
  });
  const agents = [parent, child];

  it("keeps a stale child selectable under its parent's project", () => {
    expect(isAgentInScope(child, "project-a", agents)).toBe(true);
  });

  it("keeps an older ?project link to the child's own row open", () => {
    expect(isAgentInScope(child, "project-b", agents)).toBe(true);
  });

  it("excludes it from unrelated projects", () => {
    expect(isAgentInScope(child, "project-c", agents)).toBe(false);
    expect(isAgentInScope(parent, "project-b", agents)).toBe(false);
  });
});
