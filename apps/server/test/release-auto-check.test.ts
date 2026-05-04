import { beforeEach, describe, expect, it, vi } from "vitest";

const { computeMock, getSettingMock, setSettingMock, pruneCacheMock } =
  vi.hoisted(() => ({
    computeMock: vi.fn(),
    getSettingMock: vi.fn(),
    setSettingMock: vi.fn(),
    pruneCacheMock: vi.fn(async () => {}),
  }));

vi.mock("../src/release-info.js", () => ({
  computeReleaseInfo: computeMock,
}));

vi.mock("../src/db/settings.js", () => ({
  getSetting: getSettingMock,
  setSetting: setSettingMock,
}));

// Stub the tarball-cache prune so unit tests don't touch the host's real
// `~/.dispatch/cache/` directory. The auto-check now calls it after
// every successful check; without this mock, running the suite would
// remove the user's actual cached release tarballs.
vi.mock("../src/release-tarball-cache.js", () => ({
  pruneCacheExcept: pruneCacheMock,
}));

import {
  createAutoCheckRuntime,
  readAutomaticUpdateMode,
} from "../src/release-auto-check.js";

const fakePool = {} as never;

const fakeComputeDeps = {
  pool: fakePool,
  serverDir: "/srv",
  getGitHubRepo: async () => "owner/repo",
  parseGhJson: <T>(_: string): T => ({}) as T,
  compareSemver: () => 0,
  getAppVersionInfo: async () => ({ version: "0.0.1" }),
  fetchLatestReleaseMetadata: async () => null,
};

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const baseSnapshot = {
  currentTag: "v0.18.41",
  channel: "stable" as const,
  latestTag: "v0.18.42",
  absoluteLatestTag: "v0.18.42",
  updateAvailable: true,
  latestRelease: null,
  assisted: null,
  assistedRequired: false,
  pendingMigrations: [],
  migrationsError: null,
  computedAt: "2026-05-03T00:00:00Z",
};

describe("readAutomaticUpdateMode default-on", () => {
  beforeEach(() => {
    getSettingMock.mockReset();
    setSettingMock.mockReset();
  });

  it("returns 'check' and persists when unset", async () => {
    getSettingMock.mockResolvedValueOnce(null);
    const mode = await readAutomaticUpdateMode(fakePool);
    expect(mode).toBe("check");
    expect(setSettingMock).toHaveBeenCalledWith(
      fakePool,
      "automatic_update_mode",
      "check"
    );
  });

  it("returns the stored value when set", async () => {
    getSettingMock.mockResolvedValueOnce("off");
    const mode = await readAutomaticUpdateMode(fakePool);
    expect(mode).toBe("off");
    expect(setSettingMock).not.toHaveBeenCalled();
  });

  it("falls back to default for unrecognized values", async () => {
    getSettingMock.mockResolvedValueOnce("garbage");
    const mode = await readAutomaticUpdateMode(fakePool);
    expect(mode).toBe("check");
  });
});

describe("createAutoCheckRuntime.runAutoCheckOnce", () => {
  beforeEach(() => {
    computeMock.mockReset();
    getSettingMock.mockReset();
    setSettingMock.mockReset();
    pruneCacheMock.mockReset();
    pruneCacheMock.mockImplementation(async () => {});
  });

  it("skips when mode=off", async () => {
    getSettingMock.mockResolvedValueOnce("off");
    const broadcast = vi.fn();
    const runtime = createAutoCheckRuntime({
      pool: fakePool,
      computeDeps: fakeComputeDeps,
      isApplyInProgress: () => false,
      broadcast,
      logger: noopLogger,
    });
    const result = await runtime.runAutoCheckOnce("test");
    expect(result.ok).toBe("skipped");
    expect(computeMock).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("skips when an apply is in progress", async () => {
    const broadcast = vi.fn();
    const runtime = createAutoCheckRuntime({
      pool: fakePool,
      computeDeps: fakeComputeDeps,
      isApplyInProgress: () => true,
      broadcast,
      logger: noopLogger,
    });
    const result = await runtime.runAutoCheckOnce("test");
    expect(result.ok).toBe("skipped");
    expect(computeMock).not.toHaveBeenCalled();
  });

  it("broadcasts the new snapshot on every successful check", async () => {
    getSettingMock.mockResolvedValue("check");
    computeMock.mockResolvedValueOnce({ ok: true, snapshot: baseSnapshot });
    const broadcast = vi.fn();
    const runtime = createAutoCheckRuntime({
      pool: fakePool,
      computeDeps: fakeComputeDeps,
      isApplyInProgress: () => false,
      broadcast,
      logger: noopLogger,
    });
    const result = await runtime.runAutoCheckOnce("startup");
    expect(result.ok).toBe(true);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(baseSnapshot);
    expect(runtime.getSnapshot()).toEqual(baseSnapshot);
  });

  it("broadcasts every check so clients see updateAvailable=false transitions", async () => {
    getSettingMock.mockResolvedValue("check");
    const upToDate = { ...baseSnapshot, updateAvailable: false };
    computeMock
      .mockResolvedValueOnce({ ok: true, snapshot: baseSnapshot })
      .mockResolvedValueOnce({ ok: true, snapshot: upToDate });
    const broadcast = vi.fn();
    const runtime = createAutoCheckRuntime({
      pool: fakePool,
      computeDeps: fakeComputeDeps,
      isApplyInProgress: () => false,
      broadcast,
      logger: noopLogger,
    });
    await runtime.runAutoCheckOnce("startup");
    await runtime.runAutoCheckOnce("interval");
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenLastCalledWith(upToDate);
  });

  it("keeps prior snapshot when a check fails and does not broadcast", async () => {
    getSettingMock.mockResolvedValue("check");
    computeMock
      .mockResolvedValueOnce({ ok: true, snapshot: baseSnapshot })
      .mockResolvedValueOnce({ ok: false, error: "network down" });
    const broadcast = vi.fn();
    const runtime = createAutoCheckRuntime({
      pool: fakePool,
      computeDeps: fakeComputeDeps,
      isApplyInProgress: () => false,
      broadcast,
      logger: noopLogger,
    });
    await runtime.runAutoCheckOnce("startup");
    expect(broadcast).toHaveBeenCalledTimes(1);
    const failed = await runtime.runAutoCheckOnce("interval");
    expect(failed.ok).toBe(false);
    expect(runtime.getSnapshot()).toEqual(baseSnapshot);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("broadcasts on write-through from a manual check", async () => {
    const broadcast = vi.fn();
    const runtime = createAutoCheckRuntime({
      pool: fakePool,
      computeDeps: fakeComputeDeps,
      isApplyInProgress: () => false,
      broadcast,
      logger: noopLogger,
    });
    runtime.setSnapshotForWriteThrough(baseSnapshot);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(baseSnapshot);
    expect(runtime.getSnapshot()).toEqual(baseSnapshot);
  });

  it("clears snapshot AND broadcasts null on apply for the same tag", async () => {
    getSettingMock.mockResolvedValue("check");
    computeMock.mockResolvedValueOnce({ ok: true, snapshot: baseSnapshot });
    const broadcast = vi.fn();
    const runtime = createAutoCheckRuntime({
      pool: fakePool,
      computeDeps: fakeComputeDeps,
      isApplyInProgress: () => false,
      broadcast,
      logger: noopLogger,
    });
    await runtime.runAutoCheckOnce("startup");
    broadcast.mockClear();
    runtime.clearSnapshotIfMatchesTag("v0.18.42");
    expect(runtime.getSnapshot()).toBeNull();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(null);
  });

  it("prunes the tarball cache to currentTag + latestTag after a successful check", async () => {
    getSettingMock.mockResolvedValue("check");
    computeMock.mockResolvedValueOnce({ ok: true, snapshot: baseSnapshot });
    const runtime = createAutoCheckRuntime({
      pool: fakePool,
      computeDeps: fakeComputeDeps,
      isApplyInProgress: () => false,
      broadcast: () => {},
      logger: noopLogger,
    });
    await runtime.runAutoCheckOnce("startup");
    expect(pruneCacheMock).toHaveBeenCalledTimes(1);
    expect(pruneCacheMock).toHaveBeenCalledWith(["v0.18.41", "v0.18.42"]);
  });

  it("skips pruning when an apply starts during the compute window", async () => {
    getSettingMock.mockResolvedValue("check");
    computeMock.mockResolvedValueOnce({ ok: true, snapshot: baseSnapshot });
    let applyInProgress = false;
    const runtime = createAutoCheckRuntime({
      pool: fakePool,
      computeDeps: fakeComputeDeps,
      // Toggle to true once the compute resolves but before the prune
      // step decides whether to fire.
      isApplyInProgress: () => applyInProgress,
      broadcast: () => {
        applyInProgress = true;
      },
      logger: noopLogger,
    });
    await runtime.runAutoCheckOnce("startup");
    expect(pruneCacheMock).not.toHaveBeenCalled();
  });

  it("preserves snapshot and does not broadcast on apply for a different tag", async () => {
    getSettingMock.mockResolvedValue("check");
    computeMock.mockResolvedValueOnce({ ok: true, snapshot: baseSnapshot });
    const broadcast = vi.fn();
    const runtime = createAutoCheckRuntime({
      pool: fakePool,
      computeDeps: fakeComputeDeps,
      isApplyInProgress: () => false,
      broadcast,
      logger: noopLogger,
    });
    await runtime.runAutoCheckOnce("startup");
    broadcast.mockClear();
    runtime.clearSnapshotIfMatchesTag("v0.17.99");
    expect(runtime.getSnapshot()).toEqual(baseSnapshot);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("coalesces concurrent runs into one in-flight check", async () => {
    getSettingMock.mockResolvedValue("check");
    // Slow-resolving compute so the two callers overlap.
    computeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setImmediate(() => resolve({ ok: true, snapshot: baseSnapshot }));
        })
    );
    const runtime = createAutoCheckRuntime({
      pool: fakePool,
      computeDeps: fakeComputeDeps,
      isApplyInProgress: () => false,
      broadcast: () => {},
      logger: noopLogger,
    });
    const a = runtime.runAutoCheckOnce("a");
    const b = runtime.runAutoCheckOnce("b");
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toBe(resB);
    expect(computeMock).toHaveBeenCalledTimes(1);
  });
});
