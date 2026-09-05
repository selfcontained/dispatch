// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Turn } from "./contracts";
import { parseDispatchNotice, PromptLine, splitKeyValue } from "./prompt-line";

afterEach(cleanup);

const block =
  "--- DISPATCH: REVIEW ITEM RESOLVED ---\nReview ID: 293\nFeedback item ID: 1422\nState: resolved (dismissed)\nMessage: Verified: not applicable.\nCall dispatch_event with type 'working' before handling this update.\n--- END DISPATCH: REVIEW ITEM RESOLVED ---";

describe("parseDispatchNotice", () => {
  it("names the block and digests its key lines", () => {
    const notice = parseDispatchNotice(block, "chat");
    expect(notice?.label).toBe("Review item resolved");
    expect(notice?.summary).toBe(
      "Review ID: 293 · Feedback item ID: 1422 · State: resolved (dismissed)"
    );
    expect(notice?.body.startsWith("Review ID: 293")).toBe(true);
    expect(notice?.body.includes("END DISPATCH")).toBe(false);
  });

  it("treats any system-sourced prompt as a notice, and user text as a prompt", () => {
    expect(
      parseDispatchNotice("Please set a short, descriptive name…", "system")
        ?.label
    ).toBe("System");
    expect(parseDispatchNotice("ls apps", "chat")).toBeNull();
  });
});

describe("PromptLine", () => {
  it("renders a Dispatch block as a collapsed notice that expands", () => {
    const turn: Turn = {
      id: "t",
      role: "user",
      content: block,
      timestamp: 0,
      extra: { source: "chat" },
    };
    render(<PromptLine turn={turn} />);
    const notice = screen.getByTestId("harness-notice");
    expect(notice.textContent).toContain("Review item resolved");
    expect(notice.textContent).not.toContain("Call dispatch_event");
    fireEvent.click(notice.querySelector("button") as HTMLButtonElement);
    expect(notice.textContent).toContain("Call dispatch_event");
    expect(screen.queryByTestId("harness-prompt")).toBeNull();
  });

  it("renders a typed prompt as before", () => {
    const turn: Turn = {
      id: "t",
      role: "user",
      content: "ls apps",
      timestamp: 0,
      extra: { source: "chat" },
    };
    render(<PromptLine turn={turn} />);
    expect(screen.getByTestId("harness-prompt").textContent).toContain(
      "ls apps"
    );
  });
});

describe("splitKeyValue", () => {
  it("splits a label from its value and leaves prose alone", () => {
    expect(splitKeyValue("Review ID: 293")).toEqual({
      key: "Review ID",
      value: "293",
    });
    expect(splitKeyValue("Call dispatch_event with type 'working'")).toBeNull();
  });
});
