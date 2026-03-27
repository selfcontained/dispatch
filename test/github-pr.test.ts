import { describe, expect, it, vi } from "vitest";

import {
  createPr,
  enablePrAutomerge,
  getPrStatus,
  GitHubPrError,
  mergePrNow
} from "../src/github/pr.js";

describe("github pr services", () => {
  it("creates a PR after pushing the current branch", async () => {
    const repoRoot = "/tmp/repo";
    const runner = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      switch (key) {
        case `-C ${repoRoot} rev-parse --show-toplevel`:
          return { exitCode: 0, stdout: repoRoot, stderr: "" };
        case `-C ${repoRoot} symbolic-ref --short -q HEAD`:
          return { exitCode: 0, stdout: "feature/pr-tools", stderr: "" };
        case `-C ${repoRoot} fetch origin main --quiet`:
          return { exitCode: 0, stdout: "", stderr: "" };
        case `-C ${repoRoot} rev-list --count origin/main..HEAD`:
          return { exitCode: 0, stdout: "2", stderr: "" };
        case `-C ${repoRoot} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`:
          return { exitCode: 128, stdout: "", stderr: "" };
        case `-C ${repoRoot} push --set-upstream origin feature/pr-tools`:
          return { exitCode: 0, stdout: "", stderr: "" };
        case `pr create --base main --head feature/pr-tools --fill`:
          return { exitCode: 0, stdout: "https://github.com/selfcontained/dispatch/pull/99", stderr: "" };
        case `pr view --json number,url,title,state,isDraft,reviewDecision,mergeStateStatus,mergeable,autoMergeRequest,headRefName,baseRefName,statusCheckRollup`:
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              number: 99,
              url: "https://github.com/selfcontained/dispatch/pull/99",
              title: "Add PR MCP tools",
              state: "OPEN",
              isDraft: false,
              reviewDecision: null,
              mergeStateStatus: "UNSTABLE",
              mergeable: "MERGEABLE",
              autoMergeRequest: null,
              headRefName: "feature/pr-tools",
              baseRefName: "main",
              statusCheckRollup: []
            }),
            stderr: ""
          };
        default:
          throw new Error(`Unexpected command: ${key}`);
      }
    });

    const result = await createPr({
      cwd: repoRoot,
      fillFromCommits: true
    }, runner);

    expect(result.url).toBe("https://github.com/selfcontained/dispatch/pull/99");
    expect(result.branchName).toBe("feature/pr-tools");
    expect(result.prNumber).toBe(99);
  });

  it("rejects create_pr without non-interactive title/body settings", async () => {
    const repoRoot = "/tmp/repo";
    const runner = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      switch (key) {
        case `-C ${repoRoot} rev-parse --show-toplevel`:
          return { exitCode: 0, stdout: repoRoot, stderr: "" };
        case `-C ${repoRoot} symbolic-ref --short -q HEAD`:
          return { exitCode: 0, stdout: "feature/pr-tools", stderr: "" };
        case `-C ${repoRoot} fetch origin main --quiet`:
          return { exitCode: 0, stdout: "", stderr: "" };
        case `-C ${repoRoot} rev-list --count origin/main..HEAD`:
          return { exitCode: 0, stdout: "1", stderr: "" };
        case `-C ${repoRoot} rev-parse --abbrev-ref --symbolic-full-name @{upstream}`:
          return { exitCode: 0, stdout: "origin/feature/pr-tools", stderr: "" };
        case `-C ${repoRoot} push origin feature/pr-tools`:
          return { exitCode: 0, stdout: "", stderr: "" };
        default:
          throw new Error(`Unexpected command: ${key}`);
      }
    });

    await expect(createPr({ cwd: repoRoot }, runner)).rejects.toBeInstanceOf(GitHubPrError);
  });

  it("enables auto-merge for the current branch PR", async () => {
    const repoRoot = "/tmp/repo";
    const runner = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      switch (key) {
        case `-C ${repoRoot} rev-parse --show-toplevel`:
          return { exitCode: 0, stdout: repoRoot, stderr: "" };
        case `pr merge --auto --squash`:
          return { exitCode: 0, stdout: "", stderr: "" };
        case `pr view --json number,url,title,state,isDraft,reviewDecision,mergeStateStatus,mergeable,autoMergeRequest,headRefName,baseRefName,statusCheckRollup`:
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              number: 99,
              url: "https://github.com/selfcontained/dispatch/pull/99",
              title: "Add PR MCP tools",
              state: "OPEN",
              isDraft: false,
              reviewDecision: "APPROVED",
              mergeStateStatus: "BLOCKED",
              mergeable: "MERGEABLE",
              autoMergeRequest: { enabledAt: "2026-03-13T00:00:00Z" },
              headRefName: "feature/pr-tools",
              baseRefName: "main",
              statusCheckRollup: [{ name: "ci", status: "IN_PROGRESS", conclusion: null }]
            }),
            stderr: ""
          };
        default:
          throw new Error(`Unexpected command: ${key}`);
      }
    });

    const result = await enablePrAutomerge({ cwd: repoRoot }, runner);
    expect(result.autoMergeEnabled).toBe(true);
    expect(result.mergeMethod).toBe("squash");
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
                { context: "ci", status: "COMPLETED", conclusion: "SUCCESS" }
              ]
            }),
            stderr: ""
          };
        default:
          throw new Error(`Unexpected command: ${key}`);
      }
    });

    const result = await getPrStatus({ cwd: repoRoot, prNumber: 99 }, runner);
    expect(result.number).toBe(99);
    expect(result.statusSummary).toEqual([{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]);
  });

  it("merges a PR immediately", async () => {
    const repoRoot = "/tmp/repo";
    const runner = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      switch (key) {
        case `-C ${repoRoot} rev-parse --show-toplevel`:
          return { exitCode: 0, stdout: repoRoot, stderr: "" };
        case `pr merge 99 --squash`:
          return { exitCode: 0, stdout: "", stderr: "" };
        case `pr view 99 --json number,url,title,state,isDraft,reviewDecision,mergeStateStatus,mergeable,autoMergeRequest,headRefName,baseRefName,statusCheckRollup`:
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              number: 99,
              url: "https://github.com/selfcontained/dispatch/pull/99",
              title: "Add PR MCP tools",
              state: "MERGED",
              isDraft: false,
              reviewDecision: "APPROVED",
              mergeStateStatus: "UNKNOWN",
              mergeable: "UNKNOWN",
              autoMergeRequest: null,
              headRefName: "feature/pr-tools",
              baseRefName: "main",
              statusCheckRollup: []
            }),
            stderr: ""
          };
        default:
          throw new Error(`Unexpected command: ${key}`);
      }
    });

    const result = await mergePrNow({ cwd: repoRoot, prNumber: 99 }, runner);
    expect(result.merged).toBe(true);
  });
});
