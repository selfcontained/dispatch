import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveTilde } from "../src/shared/lib/resolve-tilde.js";

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
