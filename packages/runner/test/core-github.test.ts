import { describe, expect, it, vi } from "vitest";
import { githubHandlers } from "../src/core/github.js";
import { SERVED_WHILE_FROZEN } from "../src/local/fence.js";
import type { Platform } from "../src/platform/types.js";

const workload = { run: vi.fn() } as unknown as Platform["workload"];

describe("the core's GitHub reads", () => {
  it("serves github.pr.status from the platform's port", async () => {
    const observation = {
      state: "OPEN" as const,
      draft: false,
      title: "Fix",
      head: "sha",
      rollup: [],
    };
    const pullRequestStatus = vi.fn(async () => observation);
    const handlers = githubHandlers({
      workload,
      github: { pullRequestStatus },
    });
    const request = { owner: "a", repo: "b", number: 1 };
    expect(await handlers["github.pr.status"]!(request, {} as never)).toEqual(
      observation
    );
    expect(pullRequestStatus).toHaveBeenCalledWith(request, {});
  });

  it("leaves GitHub unsupported without a port, and serves it while frozen", () => {
    expect(githubHandlers({ workload })).toEqual({});
    expect(SERVED_WHILE_FROZEN.has("github.pr.status")).toBe(true);
  });
});
