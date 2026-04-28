import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isMacProtectedPath,
  shouldSkipAutomaticMacPathProbe,
} from "../src/shared/mac-path-privacy.js";

describe("isMacProtectedPath", () => {
  const homeDir = "/Users/tester";
  const platform = "darwin";

  it("matches protected macOS home folders", () => {
    expect(
      isMacProtectedPath(path.join(homeDir, "Documents"), homeDir, platform)
    ).toBe(true);
    expect(
      isMacProtectedPath(
        path.join(homeDir, "Desktop", "repo"),
        homeDir,
        platform
      )
    ).toBe(true);
    expect(
      isMacProtectedPath(
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
    expect(
      isMacProtectedPath(
        path.join(homeDir, "Library", "CloudStorage", "Dropbox", "stuff"),
        homeDir,
        platform
      )
    ).toBe(true);
  });

  it("matches protected paths case-insensitively on darwin", () => {
    expect(
      isMacProtectedPath(
        path.join(homeDir, "documents", "repo"),
        homeDir,
        platform
      )
    ).toBe(true);
  });

  it("does not match unprotected paths", () => {
    expect(
      isMacProtectedPath(path.join(homeDir, "code"), homeDir, platform)
    ).toBe(false);
    expect(
      isMacProtectedPath(path.join(homeDir, ".dispatch"), homeDir, platform)
    ).toBe(false);
    // Sibling-of-protected doesn't match: ~/Library is not protected even
    // though ~/Library/Mobile Documents is.
    expect(
      isMacProtectedPath(path.join(homeDir, "Library"), homeDir, platform)
    ).toBe(false);
  });
});

describe("shouldSkipAutomaticMacPathProbe", () => {
  const homeDir = "/Users/tester";

  it("only skips protected paths on darwin", () => {
    expect(
      shouldSkipAutomaticMacPathProbe(
        path.join(homeDir, "Downloads"),
        homeDir,
        "darwin"
      )
    ).toBe(true);
    expect(
      shouldSkipAutomaticMacPathProbe(
        path.join(homeDir, "Downloads"),
        homeDir,
        "linux"
      )
    ).toBe(false);
  });

  it("does not invoke any filesystem syscall", () => {
    // Pass a path that does NOT exist on disk anywhere. The function must
    // return purely based on string comparison — if it ever calls
    // realpath/stat/etc. this would either throw, return false, or hit
    // TCC machinery on macOS. The async-free signature is the structural
    // guarantee, but exercising it here pins the contract: synchronous,
    // pure, no FS access. This is the property that prevents the daemon
    // hang documented in the module header.
    const fakePath = "/Users/this-user-does-not-exist/Documents/whatever";
    expect(
      isMacProtectedPath(fakePath, "/Users/this-user-does-not-exist", "darwin")
    ).toBe(true);
  });

  it("does NOT follow symlinks (intentional trade-off)", () => {
    // We deliberately don't call realpath() — see module header. A path
    // that symlinks INTO a protected dir is reported as not-protected
    // here. Downstream stat() will hit TCC against the underlying dir
    // and return EPERM in bounded time, so the request still completes
    // safely with `exists=false` rather than wedging.
    const homeDir = "/Users/tester";
    const aliased = path.join(homeDir, "work");
    expect(shouldSkipAutomaticMacPathProbe(aliased, homeDir, "darwin")).toBe(
      false
    );
  });
});
