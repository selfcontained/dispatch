// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Job } from "@/hooks/use-jobs";

import { PromptTab } from "./jobs-prompt-tab";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    directory: "/repo",
    name: "project-loop",
    schedule: null,
    timeoutMs: 1_800_000,
    needsInputTimeoutMs: 86_400_000,
    notify: null,
    prompt: "Build the next planned slice.",
    enabled: true,
    agentType: "claude",
    model: null,
    useWorktree: false,
    baseBranch: null,
    branchName: null,
    fullAccess: false,
    autoArchive: true,
    callable: false,
    singleton: true,
    webhookEnabled: false,
    webhookSecret: null,
    templateId: null,
    defaultArgs: {},
    selfImprove: false,
    continuationEnabled: true,
    maxIterations: 10,
    completionCriteria: ["The project scope is complete."],
    recoveryInstructions: null,
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:00:00.000Z",
    lastRunId: null,
    lastRunStatus: null,
    lastRunStartedAt: null,
    lastRunCompletedAt: null,
    lastRunDurationMs: null,
    lastRunReport: null,
    continuationPending: false,
    lastRunChainId: null,
    lastRunIteration: null,
    nextRun: null,
    ...overrides,
  };
}

describe("PromptTab loop setup", () => {
  it("keeps the task prompt and loop instructions in one editing flow", async () => {
    const onUpdateJob = vi.fn().mockResolvedValue(undefined);
    render(
      <PromptTab job={makeJob()} onUpdateJob={onUpdateJob} isUpdating={false} />
    );

    expect(screen.getByLabelText("Task prompt")).toBeTruthy();
    expect(screen.getByText("Loop setup")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Done when item 1"), {
      target: { value: "Every planned slice is shipped." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save instructions" }));

    await waitFor(() => expect(onUpdateJob).toHaveBeenCalledTimes(1));
    expect(onUpdateJob).toHaveBeenCalledWith({
      name: "project-loop",
      directory: "/repo",
      prompt: "Build the next planned slice.",
      selfImprove: false,
      continuationEnabled: true,
      maxIterations: 10,
      completionCriteria: ["Every planned slice is shipped."],
      recoveryInstructions: null,
      autoArchive: true,
    });
  });
});
