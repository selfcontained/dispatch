import { describe, it, expect } from "vitest";
import { parseSystemEvent, systemEventOf, type Block } from "@dispatch/shared";
import { checkSummary } from "../src/agents/pull-request-check-notice.js";
import { riskFixture } from "./pull-request-risk-fixture.js";

describe("bounded system observations", () => {
  it("rejects unsupported versions, oversized summaries, invalid heads and crossed semantics", () => {
    const base = {
      version: 1,
      category: "risk",
      summary: "Merge-risk assessment",
      risk: "routine",
    };
    expect(parseSystemEvent(base)).toEqual(base);
    for (const invalid of [
      { ...base, version: 2 },
      { ...base, summary: "a".repeat(161) },
      { ...base, head: "<script>" },
      { ...base, status: "Passing" },
      { ...base, category: "unknown" },
    ])
      expect(parseSystemEvent(invalid)).toBeUndefined();
  });
  it("projects metadata from legacy records only for trusted system authors, without mutation", () => {
    const legacy = {
      kind: "text",
      author: { kind: "system" },
      data: {
        pullRequestTransition: {
          observation: "merge_risk",
          recommendation: "Routine change recommendation",
          headSha: "abc123",
        },
      },
    } as unknown as Block;
    const before = JSON.stringify(legacy);
    expect(systemEventOf(legacy)).toMatchObject({
      category: "risk",
      risk: "routine",
      head: "abc123",
    });
    expect(JSON.stringify(legacy)).toBe(before);
    expect(
      systemEventOf({
        ...legacy,
        author: { kind: "agent", agentId: "attacker" },
      })
    ).toBeUndefined();
    expect(
      systemEventOf({
        ...legacy,
        data: {
          systemEvent: {
            version: 1,
            category: "checks",
            summary: "Checks",
            status: "Pending",
          },
        },
      } as Block)
    ).toMatchObject({ status: "Pending" });
  });
  it("never equates routine risk or neutral/missing checks with successful checks", () => {
    const pr = riskFixture();
    expect(checkSummary(pr)).toBe("Passing");
    pr.ci!.checks[0].conclusion = "CANCELLED";
    expect(checkSummary(pr)).toBe("Mixed");
    pr.ci!.checks[0].status = "IN_PROGRESS";
    expect(checkSummary(pr)).toBe("Pending");
    pr.ci!.checks[0].status = "COMPLETED";
    pr.ci!.checks[0].conclusion = "FAILURE";
    expect(checkSummary(pr)).toBe("Failing");
    pr.ci!.checks = [];
    expect(checkSummary(pr)).toBe("Pending");
  });
});
