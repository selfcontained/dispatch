import { describe, expect, it, vi } from "vitest";

import {
  refreshRemoteBaseRef,
  resolveBaseRef,
} from "../src/shared/git/base-ref.js";

function ok(stdout = "") {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(stdout = "") {
  return { exitCode: 1, stdout, stderr: "" };
}

describe("refreshRemoteBaseRef", () => {
  it("fetches the configured base branch from origin", async () => {
    const calls: string[] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args.join(" "));
      return ok("");
    });

    await refreshRemoteBaseRef("/wt", "main", { runCommand });

    expect(calls).toContain("-C /wt fetch origin main --quiet");
  });

  it("strips the origin/ prefix when a remote ref is provided", async () => {
    const calls: string[] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args.join(" "));
      return ok("");
    });

    await refreshRemoteBaseRef("/wt", "origin/release/2026.05", {
      runCommand,
    });

    expect(calls).toContain("-C /wt fetch origin release/2026.05 --quiet");
  });

  it("falls back to origin/main when baseBranch is missing", async () => {
    const calls: string[] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args.join(" "));
      return ok("");
    });

    await refreshRemoteBaseRef("/wt", null, { runCommand });

    expect(calls).toContain("-C /wt fetch origin main --quiet");
    expect(calls).not.toContain("-C /wt rev-parse --abbrev-ref @{upstream}");
  });

  it("swallows fetch failures so review can fall back to local tracking refs", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "-C /wt fetch origin main --quiet") {
        throw new Error("network down");
      }
      return ok("");
    });

    await expect(
      refreshRemoteBaseRef("/wt", "main", { runCommand })
    ).resolves.toBeUndefined();
  });
});

describe("resolveBaseRef", () => {
  it("falls back to origin/main when preferred baseBranch is missing", async () => {
    const calls: string[] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      calls.push(key);
      if (key === "-C /wt rev-parse --verify --quiet origin/main") {
        return ok("origin/main");
      }
      if (key === "-C /wt rev-parse --verify --quiet main") {
        return fail("");
      }
      throw new Error(`Unexpected command: ${key}`);
    });

    const result = await resolveBaseRef("/wt", null, { runCommand });

    expect(result).toBe("origin/main");
    expect(calls).not.toContain("-C /wt rev-parse --abbrev-ref @{upstream}");
    expect(calls).not.toContain("-C /wt rev-parse --verify --quiet main");
  });

  it("prefers origin/main over local main when preferred is main", async () => {
    const calls: string[] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      calls.push(key);
      if (key === "-C /wt rev-parse --verify --quiet origin/main") {
        return ok("origin/main");
      }
      if (key === "-C /wt rev-parse --verify --quiet main") {
        return fail("");
      }
      if (key === "-C /wt rev-parse --abbrev-ref @{upstream}") {
        return { exitCode: 128, stdout: "", stderr: "no upstream" };
      }
      throw new Error(`Unexpected command: ${key}`);
    });

    const result = await resolveBaseRef("/wt", "main", { runCommand });

    expect(result).toBe("origin/main");
    expect(calls).not.toContain("-C /wt rev-parse --verify --quiet main");
  });

  it("prefers origin/<branch> over the local branch when both are available", async () => {
    const calls: string[] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(" ");
      calls.push(key);
      if (key === "-C /wt rev-parse --verify --quiet origin/release/2026.05") {
        return ok("origin/release/2026.05");
      }
      if (key === "-C /wt rev-parse --verify --quiet release/2026.05") {
        throw new Error("resolveBaseRef should prefer origin/<branch> first");
      }
      throw new Error(`Unexpected command: ${key}`);
    });

    const result = await resolveBaseRef("/wt", "release/2026.05", {
      runCommand,
    });

    expect(result).toBe("origin/release/2026.05");
    expect(calls).not.toContain(
      "-C /wt rev-parse --verify --quiet release/2026.05"
    );
  });
});
