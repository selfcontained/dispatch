import path from "node:path";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  isMacProtectedPath,
  shouldSkipAutomaticMacPathProbe,
} from "../src/shared/mac-path-privacy.js";

describe("isMacProtectedPath", () => {
  const homeDir = "/Users/tester";
  const platform = "darwin";

  it("matches protected macOS home folders", async () => {
    await expect(
      isMacProtectedPath(path.join(homeDir, "Documents"), homeDir, platform)
    ).resolves.toBe(true);
    expect(
      await isMacProtectedPath(
        path.join(homeDir, "Desktop", "repo"),
        homeDir,
        platform
      )
    ).toBe(true);
    expect(
      await isMacProtectedPath(
        path.join(
          homeDir,
          "Library",
          "Mobile Documents",
          "com~apple~CloudDocs"
        ),
        homeDir,
        platform
      )
    ).toBe(true);
  });

  it("matches protected paths case-insensitively on darwin", async () => {
    await expect(
      isMacProtectedPath(
        path.join(homeDir, "documents", "repo"),
        homeDir,
        platform
      )
    ).resolves.toBe(true);
  });

  it("does not match unprotected paths", async () => {
    await expect(
      isMacProtectedPath(path.join(homeDir, "code"), homeDir, platform)
    ).resolves.toBe(false);
    await expect(
      isMacProtectedPath(path.join(homeDir, ".dispatch"), homeDir, platform)
    ).resolves.toBe(false);
  });
});

describe("shouldSkipAutomaticMacPathProbe", () => {
  const homeDir = "/Users/tester";

  it("only skips protected paths on darwin", async () => {
    await expect(
      shouldSkipAutomaticMacPathProbe(
        path.join(homeDir, "Downloads"),
        homeDir,
        "darwin"
      )
    ).resolves.toBe(true);
    await expect(
      shouldSkipAutomaticMacPathProbe(
        path.join(homeDir, "Downloads"),
        homeDir,
        "linux"
      )
    ).resolves.toBe(false);
  });
});

describe("symlink handling", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  it("treats symlinks into protected folders as protected", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dispatch-mac-privacy-"));
    tempDirs.push(root);
    const homeDir = path.join(root, "home");
    const protectedTarget = path.join(homeDir, "Documents", "project");
    const symlinkPath = path.join(homeDir, "work");

    await mkdir(protectedTarget, { recursive: true });
    await symlink(protectedTarget, symlinkPath, "dir");

    await expect(
      shouldSkipAutomaticMacPathProbe(symlinkPath, homeDir, "darwin")
    ).resolves.toBe(true);
  });
});
