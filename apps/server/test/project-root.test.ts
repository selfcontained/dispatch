import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveProjectRoot } from "../src/routes/projects.js";

describe("resolveProjectRoot", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-project-root-")));
  });
  afterEach(() => {
    delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    rmSync(root, { recursive: true, force: true });
  });

  it("uses a plain folder as its own root", async () => {
    mkdirSync(join(root, "plain"));
    await expect(resolveProjectRoot(join(root, "plain"))).resolves.toBe(
      join(root, "plain")
    );
  });

  it("rejects instead of falling back when Git fails inside a checkout", async () => {
    execFileSync("git", ["init", "-q", join(root, "repo")]);
    mkdirSync(join(root, "repo/nested"));
    await expect(resolveProjectRoot(join(root, "repo/nested"))).resolves.toBe(
      join(root, "repo")
    );
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
    await expect(resolveProjectRoot(join(root, "repo/nested"))).rejects.toThrow(
      /dubious ownership/
    );
  });
});
