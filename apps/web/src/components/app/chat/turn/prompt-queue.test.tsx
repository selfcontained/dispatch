// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessQueuedPrompt } from "@dispatch/shared";

import { PromptQueue } from "./prompt-queue";

afterEach(cleanup);

describe("PromptQueue", () => {
  const queued: HarnessQueuedPrompt[] = Array.from({ length: 12 }, (_, i) => ({
    id: `q_${i}`,
    source: "agent",
    attachments: [],
    senderName: `Reviewer ${i}`,
    text: `Review ${i} finished`,
    createdAt: "2026-09-11T00:00:00.000Z",
  }));

  it("folds a review backlog and retains individual actions when expanded", () => {
    const onSendNow = vi.fn();
    const onRemove = vi.fn();
    render(
      <PromptQueue
        queued={queued}
        busyId={null}
        onSendNow={onSendNow}
        onRemove={onRemove}
      />
    );
    const toggle = screen.getByRole("button", { name: "12 queued messages" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("harness-queued")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("harness-queued")).toHaveLength(12);
    fireEvent.click(screen.getAllByTestId("harness-queued-send-now")[11]!);
    expect(onSendNow).toHaveBeenCalledWith("q_11");
    fireEvent.click(screen.getAllByTestId("harness-queued-remove")[3]!);
    expect(onRemove).toHaveBeenCalledWith("q_3");
    fireEvent.click(toggle);
    expect(screen.queryByTestId("harness-queued")).toBeNull();
  });

  it("keeps a small queue visible and disables all actions during a mutation", () => {
    render(
      <PromptQueue
        queued={queued.slice(0, 2)}
        busyId="q_0"
        onSendNow={vi.fn()}
        onRemove={vi.fn()}
      />
    );
    expect(screen.getAllByTestId("harness-queued")).toHaveLength(2);
    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
