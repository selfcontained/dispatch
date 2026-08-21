import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveConfiguredPath,
  resolveTilde,
} from "../src/shared/lib/resolve-tilde.js";

describe("resolveTilde", () => {
  const home = os.homedir();

  it("expands ~/path to the home directory", () => {
    expect(resolveTilde("~/Documents")).toBe(path.join(home, "Documents"));
  });

  it("expands ~/nested/path", () => {
    expect(resolveTilde("~/a/b/c")).toBe(path.join(home, "a", "b", "c"));
  });

  it("expands bare ~ to the home directory", () => {
    expect(resolveTilde("~")).toBe(home);
  });

  it("leaves absolute paths unchanged", () => {
    expect(resolveTilde("/usr/local/bin")).toBe("/usr/local/bin");
  });

  it("leaves relative paths unchanged", () => {
    expect(resolveTilde("relative/path")).toBe("relative/path");
  });

  it("does not expand ~user-style paths", () => {
    expect(resolveTilde("~otheruser/dir")).toBe("~otheruser/dir");
  });

  it("leaves empty string unchanged", () => {
    expect(resolveTilde("")).toBe("");
  });

  it("handles ~/. (trailing dot)", () => {
    expect(resolveTilde("~/.config")).toBe(path.join(home, ".config"));
  });
});

describe("resolveConfiguredPath", () => {
  const home = os.homedir();

  it("expands a leading tilde instead of creating a directory named ~", () => {
    // The bug this exists to prevent: a config value is never read by a
    // shell, so an unexpanded "~/..." becomes a literal "~" directory next
    // to the process cwd, and writes succeed where nothing can find them.
    const resolved = resolveConfiguredPath("~/.dispatch/media");
    expect(resolved).toBe(path.join(home, ".dispatch", "media"));
    expect(resolved).not.toContain("~");
  });

  it("expands a bare tilde", () => {
    expect(resolveConfiguredPath("~")).toBe(path.resolve(home));
  });

  it("leaves an absolute path unchanged", () => {
    expect(resolveConfiguredPath("/var/lib/dispatch/media")).toBe(
      "/var/lib/dispatch/media"
    );
  });

  it("makes a relative path absolute against the working directory", () => {
    expect(resolveConfiguredPath("relative/dir")).toBe(
      path.resolve("relative/dir")
    );
  });

  it("does not expand ~user-style paths, but still absolutizes them", () => {
    // No home lookup for another user, so `~otheruser` stays a literal name.
    // Matching resolveTilde here is deliberate: expanding it would guess.
    expect(resolveConfiguredPath("~otheruser/dir")).toBe(
      path.resolve("~otheruser/dir")
    );
  });
});
