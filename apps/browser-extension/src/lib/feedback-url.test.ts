import { describe, expect, it } from "vitest";
import { feedbackUrl } from "./feedback-url";
const receipt = {
  submissionId: "submission",
  status: "failed" as const,
  streamId: "root",
  blockId: "feedback",
  threadId: null,
};
describe("feedbackUrl", () => {
  it("locates top-level feedback by block even after later posts arrive", () => {
    expect(feedbackUrl("http://localhost:58044", receipt)).toBe(
      "http://localhost:58044/agents/root?block=feedback"
    );
  });
  it("opens the child's launch-card thread and locates its feedback", () => {
    expect(
      feedbackUrl("http://localhost:58044", { ...receipt, threadId: "launch" })
    ).toBe("http://localhost:58044/agents/root?thread=launch&block=feedback");
  });
  it("does not offer a broken link for a receipt without a retained post", () => {
    expect(
      feedbackUrl("http://localhost:58044", { ...receipt, blockId: null })
    ).toBeNull();
  });
});
