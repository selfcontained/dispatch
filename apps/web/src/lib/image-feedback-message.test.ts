import { describe, expect, it } from "vitest";
import { imageFeedbackMessage } from "./image-feedback-message";
import { mentionSpans } from "./mentions";

describe("imageFeedbackMessage", () => {
  it("keeps known agent mentions literal in both note and source filename", () => {
    const note = "Ask @reviewer and @builder to explain !@reviewer";
    const filename = "@builder screenshot.png";
    const message = imageFeedbackMessage(note, filename, 2);
    expect(
      mentionSpans(message, [
        { id: "r", name: "reviewer" },
        { id: "b", name: "builder" },
      ]).filter((span) => span.kind === "mention")
    ).toEqual([]);
    expect(message.replace(/\u200b/g, "")).toBe(
      `${note}\n\nFeedback on ${filename} · Callout 2`
    );
    expect(note).toBe("Ask @reviewer and @builder to explain !@reviewer");
  });
});
