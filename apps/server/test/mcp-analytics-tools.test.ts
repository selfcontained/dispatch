import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerAnalyticsTools } from "../src/shared/mcp/analytics-tools.js";

type RegisteredTool = {
  name: string;
  config: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    structuredContent?: Record<string, unknown>;
    content: Array<{ text: string }>;
    isError?: true;
  }>;
};

function createMockServer() {
  const tools: RegisteredTool[] = [];
  return {
    registerTool: vi.fn(
      (
        name: string,
        config: Record<string, unknown>,
        handler: RegisteredTool["handler"]
      ) => {
        tools.push({ name, config, handler });
      }
    ),
    tools,
  };
}

const SUMMARY = {
  period: { start: "2026-01-01T00:00:00Z", end: "2026-01-15T00:00:00Z" },
  totalFindings: 7,
  bySeverity: { critical: 0, high: 1, medium: 2, low: 3, info: 1 },
  groups: [
    {
      key: "security-review",
      count: 40,
      // 40 distinct descriptions, of which telemetry returns only the top 5.
      distinctFindings: 40,
      bySeverity: { critical: 0, high: 1, medium: 2, low: 2, info: 0 },
      topFindings: [
        {
          description: "d".repeat(300),
          count: 3,
          severity: "high",
          exampleFilePath: "src/a.ts",
        },
        {
          description: "e".repeat(300),
          count: 2,
          severity: "medium",
          exampleFilePath: "src/b.ts",
        },
      ],
    },
    {
      key: "ux-review",
      count: 2,
      distinctFindings: 1,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 1, info: 1 },
      topFindings: [
        {
          description: "f".repeat(300),
          count: 2,
          severity: "low",
          exampleFilePath: null,
        },
      ],
    },
  ],
  reviewVerdicts: { total: 3, approved: 2, changesRequested: 1 },
};

describe("get_feedback_summary", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    server = createMockServer();
    registerAnalyticsTools(server as never, new Set(["get_feedback_summary"]), {
      getFeedbackSummary: vi.fn(async () => SUMMARY),
    } as never);
  });

  it("counts findings per group instead of listing their text", async () => {
    const result = await server.tools[0]!.handler({});
    const groups = result.structuredContent!.groups as Array<
      Record<string, unknown>
    >;

    expect(groups.map((g) => g.key)).toEqual(["security-review", "ux-review"]);
    expect(groups[0]!.topFindings).toBeUndefined();
    // The count reported is the true number of distinct findings, not the
    // length of the capped topFindings slice — 40 must not read as 2.
    expect(groups[0]!.distinctFindings).toBe(40);
    expect(groups[1]!.distinctFindings).toBe(1);
    // The aggregate itself survives — it is what the summary is for.
    expect(groups[0]!.bySeverity).toEqual(SUMMARY.groups[0]!.bySeverity);
    expect(result.structuredContent!.totalFindings).toBe(7);
    expect(groups[0]!.count).toBe(40);
    expect(result.structuredContent!.reviewVerdicts).toEqual(
      SUMMARY.reviewVerdicts
    );
  });

  it("returns one named group's findings in full", async () => {
    const result = await server.tools[0]!.handler({ group: "ux-review" });
    const group = result.structuredContent!.group as Record<string, unknown>;

    expect(group.key).toBe("ux-review");
    expect(group.topFindings).toEqual(SUMMARY.groups[1]!.topFindings);
    // The detail read drops the other groups rather than repeating them.
    expect(result.structuredContent!.groups).toBeUndefined();
    expect(result.structuredContent!.period).toEqual(SUMMARY.period);
  });

  it("errors on an unknown group instead of returning an empty result", async () => {
    const result = await server.tools[0]!.handler({ group: "nope" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('No group "nope"');
    // The error names the keys that do exist, so a typo is recoverable.
    expect(result.content[0]!.text).toContain("security-review");
  });

  it("errors instead of emitting an empty response when groups are malformed", async () => {
    for (const bad of [{}, { groups: "nope" }, { groups: [null] }]) {
      const local = createMockServer();
      registerAnalyticsTools(
        local as never,
        new Set(["get_feedback_summary"]),
        { getFeedbackSummary: vi.fn(async () => bad) } as never
      );

      const result = await local.tools[0]!.handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("without usable groups");
    }
  });
});
