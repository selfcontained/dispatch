import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentPullRequest, MergeRiskSummary } from "@dispatch/shared";
import {
  createRiskReader,
  registerPullRequestRiskTool,
} from "../src/shared/mcp/pull-request-risk-tools.js";
const url = "https://github.com/org/repo/pull/1";
const risk: MergeRiskSummary = {
  verdict: "routine",
  headSha: "head",
  assessedAt: "2026-11-10T00:00:00Z",
  status: "success",
  promptVersion: "v1",
  confidence: 0.9,
  changeRisk: 0,
  changeRiskLabel: "low",
  reviewAdequate: 1,
  descriptionMatches: 1,
  newSurface: 0,
  routineProbability: 0.9,
  humanReviewProbability: 0.1,
};
function fixture(
  mergeRisk: MergeRiskSummary | undefined = risk,
  enabled = true
) {
  const pr: AgentPullRequest = {
    url,
    title: "fixture",
    status: "Open",
    ci: {
      headSha: "head",
      checkedAt: "2026-11-10T01:00:00Z",
      availability: "available",
      summary: {
        status: "passing",
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        skipped: 0,
      },
      checks: [],
    },
    mergeRisk,
  };
  const inventory = {
    get: vi.fn(() => [pr]),
    refreshOne: vi.fn(),
    assess: vi.fn(),
  };
  const read = createRiskReader({
    caller: { id: "self", projectId: "p" },
    getAgent: async (id) =>
      id === "missing" ? null : { projectId: id === "foreign" ? "other" : "p" },
    visibleAgents: async () => [{ id: "visible" }, { id: "foreign" }],
    inventory,
    enabled: async () => enabled,
  });
  return { read, inventory, pr };
}
describe("cached PR risk", () => {
  it("invokes the registered tool with synthetic provenance and no work", async () => {
    const { read, inventory, pr } = fixture();
    pr.status = "Draft";
    const server = new McpServer({ name: "fixture", version: "1" });
    registerPullRequestRiskTool(
      server,
      new Set(["get_pull_request_risk"]),
      read
    );
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const result = await client.callTool({
        name: "get_pull_request_risk",
        arguments: {
          agentId: "visible",
          url: "https://github.com/ORG/REPO/pull/01",
        },
      });
      expect(result.isError).toBeFalsy();
      const data = JSON.parse((result.content as { text: string }[])[0]!.text);
      expect(data).toMatchObject({
        lifecycle: "Draft",
        headSha: "head",
        state: "current",
        source: "cached_inventory",
        currentAssessment: { headSha: "head", assessedAt: risk.assessedAt },
        mergeApproval: false,
      });
      expect(inventory.refreshOne).not.toHaveBeenCalled();
      expect(inventory.assess).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
  it.each(["missing", "foreign", "hidden"])(
    "rejects inaccessible agent %s without reading inventory",
    async (agentId) => {
      const { read, inventory } = fixture();
      await expect(read({ agentId, url })).rejects.toThrow("authorized scope");
      expect(inventory.get).not.toHaveBeenCalled();
    }
  );
  it("rejects unknown and invalid PRs", async () => {
    const { read } = fixture();
    await expect(read({ agentId: "self", url: url + "2" })).rejects.toThrow(
      "PR not found"
    );
    await expect(
      read({ agentId: "self", url: "https://example.com" })
    ).rejects.toThrow("github.com");
  });
  it.each([
    [undefined, true, "absent"],
    [risk, false, "disabled"],
    [{ ...risk, headSha: "old" }, true, "stale"],
    [{ ...risk, verdict: "abstain" }, true, "inconclusive"],
    [
      { ...risk, assessedAt: "", displayState: "evaluating", previous: risk },
      true,
      "evaluating",
    ],
  ] as const)("separates lifecycle %s", async (value, enabled, state) => {
    const { read, pr } = fixture(
      value as MergeRiskSummary | undefined,
      enabled
    );
    pr.mergeRisk = value as MergeRiskSummary | undefined;
    const result = (await read({ agentId: "self", url })) as {
      state: string;
      currentAssessment: unknown;
      priorAssessment: unknown;
    };
    expect(result.state).toBe(state);
    if (state !== "inconclusive") expect(result.currentAssessment).toBeNull();
    if (state === "disabled") expect(result.priorAssessment).toBeNull();
  });
});
