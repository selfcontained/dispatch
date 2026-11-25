import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { pathFromWire } from "@dispatch/runner-protocol/contract";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";

it("preserves main's shorthand lookup when main is a tag and feature is the only branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "default-branch-tag-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  try {
    git("init", "-qb", "feature");
    git(
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture"
    );
    git("tag", "main");
    const runner = runnerDirectory({}).for(controllerPlacement);
    const result = await runner.call("git.defaultBranch", {
      target: { path: pathFromWire(dir) },
    });
    expect(result.branch).toBe("main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
