import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Each case needs a module whose mismatch flag is unset, and the flag is
 * module state, so the module is re-imported per test rather than reset.
 */
async function freshVersion() {
  vi.resetModules();
  return import("./version");
}

describe("noteServerVersion", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("ignores a header that matches the bundle", async () => {
    const v = await freshVersion();
    v.noteServerVersion(v.BUILD_VERSION);
    expect(v.isVersionMismatch()).toBe(false);
  });

  it("flags a different version", async () => {
    const v = await freshVersion();
    v.noteServerVersion("99.0.0");
    expect(v.isVersionMismatch()).toBe(true);
  });

  it("ignores an absent header", async () => {
    const v = await freshVersion();
    v.noteServerVersion(null);
    v.noteServerVersion(undefined);
    v.noteServerVersion("");
    expect(v.isVersionMismatch()).toBe(false);
  });
});

describe("noteServerBuild", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("flags a rebuild that kept the same version", async () => {
    // The case the version check cannot see: deploying a branch build over
    // another leaves the semver alone, so only the build id moves.
    const v = await freshVersion();
    v.noteServerVersion(v.BUILD_VERSION);
    v.noteServerBuild("aaaaaaaaaaaa");
    expect(v.isVersionMismatch()).toBe(true);
  });

  it("ignores the build it was compiled from", async () => {
    const v = await freshVersion();
    v.noteServerBuild(v.BUILD_ID);
    expect(v.isVersionMismatch()).toBe(false);
  });

  it("stays quiet when either side has no build id", async () => {
    // A build made without git reports null. Comparing that against a real
    // sha would strand every client behind a banner it can never clear.
    const v = await freshVersion();
    v.noteServerBuild(null);
    v.noteServerBuild("");
    expect(v.isVersionMismatch()).toBe(false);
  });
});
