import { describe, expect, it } from "vitest";
import { riskNotice } from "../src/agents/pull-request-risk-notice.js";
import { riskFixture } from "./risk-fixture.js";

describe("risk observation", () => {
  it("uses a durable per-result, per-owner identity and explicit non-approval wording", () => {
    const pr = riskFixture();
    const first = riskNotice(pr, "owner")!;
    expect(first.text).toContain("Routine change recommendation");
    expect(first.text).toContain("abc123");
    expect(first.text).toContain("not merge approval");
    expect(riskNotice(structuredClone(pr), "owner")?.id).toBe(first.id);
    expect(riskNotice(pr, "other")?.id).not.toBe(first.id);
    pr.mergeRisk!.assessmentId = "review-result-2";
    expect(riskNotice(pr, "owner")?.id).not.toBe(first.id);
    pr.mergeRisk!.verdict = "abstain";
    expect(riskNotice(pr, "owner")?.text).toContain(
      "Inconclusive — no confident recommendation"
    );
  });
  it("rejects progress, disabled history, stale heads and noneligible observations", () => {
    const pr = riskFixture();
    for (const displayState of [
      "disabled",
      "evaluating",
      "waiting_review",
      "failure",
    ] as const) {
      expect(
        riskNotice(
          {
            ...pr,
            mergeRisk: {
              ...pr.mergeRisk!,
              displayState,
              previous: pr.mergeRisk,
            },
          },
          "owner"
        )
      ).toBeUndefined();
    }
    expect(
      riskNotice(
        { ...pr, mergeRisk: { ...pr.mergeRisk!, headSha: "old" } },
        "owner"
      )
    ).toBeUndefined();
    expect(riskNotice({ ...pr, status: "Merged" }, "owner")).toBeUndefined();
    expect(
      riskNotice(
        { ...pr, mergeRisk: { ...pr.mergeRisk!, status: "error" } },
        "owner"
      )
    ).toBeUndefined();
  });
});
