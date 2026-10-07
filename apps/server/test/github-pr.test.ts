import { describe, expect, it, vi } from "vitest";

import { getPrStatus, GitHubPrError } from "../src/shared/github/pr.js";

describe("github pr services", () => {
  it("rejects with a 404 GitHubPrError outside a git repository", async () => {
    const runner = vi.fn(async (_command: string, args: string[]) => {
      throw new Error(`fatal: not a git repository: ${args.join(" ")}`);
    });

    const createPromise = getPrStatus({ cwd: "/tmp/not-a-repo" }, runner);
    await expect(createPromise).rejects.toBeInstanceOf(GitHubPrError);
    await expect(createPromise).rejects.toMatchObject({
      message: "No git repository found for the provided working directory.",
      statusCode: 404,
    });

    const statusPromise = getPrStatus({ cwd: "/tmp/not-a-repo" }, runner);
    await expect(statusPromise).rejects.toBeInstanceOf(GitHubPrError);
    await expect(statusPromise).rejects.toMatchObject({
      message: "No git repository found for the provided working directory.",
      statusCode: 404,
    });
  });

  it("reports PR status details", async () => {
    const repoRoot = "/tmp/repo";
    const runner = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      switch (key) {
        case `-C ${repoRoot} rev-parse --show-toplevel`:
          return { exitCode: 0, stdout: repoRoot, stderr: "" };
        case `pr view 99 --json number,url,title,state,isDraft,reviewDecision,mergeStateStatus,mergeable,autoMergeRequest,headRefName,baseRefName,statusCheckRollup`:
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              number: 99,
              url: "https://github.com/selfcontained/dispatch/pull/99",
              title: "Add PR MCP tools",
              state: "OPEN",
              isDraft: false,
              reviewDecision: "APPROVED",
              mergeStateStatus: "CLEAN",
              mergeable: "MERGEABLE",
              autoMergeRequest: null,
              headRefName: "feature/pr-tools",
              baseRefName: "main",
              statusCheckRollup: [
                { context: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
              ],
            }),
            stderr: "",
          };
        default:
          throw new Error(`Unexpected command: ${key}`);
      }
    });

    const result = await getPrStatus({ cwd: repoRoot, prNumber: 99 }, runner);
    expect(result.number).toBe(99);
    expect(result.statusSummary).toEqual([
      { name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
    ]);
  });
});
