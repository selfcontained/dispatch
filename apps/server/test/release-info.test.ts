import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const { getSettingMock, readReleaseStoreMock, runCommandMock } = vi.hoisted(
  () => ({
    getSettingMock: vi.fn(),
    readReleaseStoreMock: vi.fn(),
    runCommandMock: vi.fn(),
  })
);

vi.mock("../src/db/settings.js", () => ({
  getSetting: getSettingMock,
}));

vi.mock("../src/release-store.js", () => ({
  readReleaseStore: readReleaseStoreMock,
}));

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: runCommandMock,
}));

import {
  computeReleaseInfo,
  resolveReleaseChannel,
  type ComputeReleaseInfoDeps,
  type ComputeReleaseInfoResult,
  type ReleaseInfoSnapshot,
} from "../src/release-info.js";
import { compareSemver } from "../src/server/release-helpers.js";
import type { ReleaseProgress } from "../src/server/release-wire.js";

type GhRelease = { tagName: string; isPrerelease: boolean };

let releaseList: GhRelease[] = [];
let releaseListError: Error | undefined;

function expectOk(
  result: ComputeReleaseInfoResult
): asserts result is { ok: true; snapshot: ReleaseInfoSnapshot } {
  if (!result.ok) {
    throw new Error(`expected ok result, got error: ${result.error}`);
  }
}

function expectFailed(
  result: ComputeReleaseInfoResult
): asserts result is { ok: false; error: string } {
  if (result.ok) {
    throw new Error(
      `expected failed result, got snapshot for ${result.snapshot.latestTag}`
    );
  }
}

/** Route runCommand calls to canned results by command shape. */
function stubCommands(opts: {
  fetchError?: Error;
  ghReleases?: GhRelease[];
  ghError?: Error;
  gitTags?: string[];
}): void {
  releaseList = opts.ghReleases ?? [];
  releaseListError = opts.fetchError ?? opts.ghError;
  runCommandMock.mockImplementation(async (command: string, args: string[]) => {
    if (command === "git" && args[2] === "fetch") {
      if (opts.fetchError) throw opts.fetchError;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command === "gh") {
      if (opts.ghError) throw opts.ghError;
      return {
        exitCode: 0,
        stdout: JSON.stringify(opts.ghReleases ?? []),
        stderr: "",
      };
    }
    if (command === "git" && args[2] === "tag") {
      return {
        exitCode: 0,
        stdout: (opts.gitTags ?? []).join("\n"),
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  });
}

function makeDeps(
  overrides: Partial<ComputeReleaseInfoDeps> = {}
): ComputeReleaseInfoDeps {
  return {
    pool: {} as Pool,
    compareSemver,
    fetchGitHubReleases: vi.fn(async () => {
      if (releaseListError) throw releaseListError;
      return releaseList.map((release) => ({
        tag: release.tagName,
        publishedAt: "2026-08-01T00:00:00Z",
        url: `https://github.com/owner/repo/releases/tag/${release.tagName}`,
        prerelease: release.isPrerelease,
        hasDispatchArtifact: true,
      }));
    }),
    getAppVersionInfo: vi.fn(async () => ({ version: null })),
    fetchLatestReleaseMetadata: vi.fn(async () => null),
    ...overrides,
  };
}

function releaseMeta(body: string | null, tag = "v0.19.0") {
  return async () => ({
    tag,
    publishedAt: "2026-08-01T00:00:00Z",
    url: `https://github.com/owner/repo/releases/tag/${tag}`,
    body,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  // Defaults: healthy install on stable channel, no update available.
  readReleaseStoreMock.mockResolvedValue({ tag: "v0.18.0" });
  getSettingMock.mockResolvedValue(null);
  stubCommands({ ghReleases: [] });
});

describe("deriveCurrentTag chain", () => {
  it("prefers the release-store tag and never consults version info", async () => {
    readReleaseStoreMock.mockResolvedValue({ tag: "v0.17.5" });
    const deps = makeDeps();
    stubCommands({ ghReleases: [{ tagName: "v0.17.5", isPrerelease: false }] });

    const result = await computeReleaseInfo(deps);

    expectOk(result);
    expect(result.snapshot.currentTag).toBe("v0.17.5");
    expect(deps.getAppVersionInfo).not.toHaveBeenCalled();
  });

  it("falls back to a v-prefixed app version when the store is empty", async () => {
    readReleaseStoreMock.mockResolvedValue(null);
    const deps = makeDeps({
      getAppVersionInfo: vi.fn(async () => ({ version: " 1.2.3 " })),
    });

    const result = await computeReleaseInfo(deps);

    expectOk(result);
    expect(result.snapshot.currentTag).toBe("v1.2.3");
  });

  it("returns null currentTag when the app version is not plain semver", async () => {
    readReleaseStoreMock.mockResolvedValue(null);
    const deps = makeDeps({
      getAppVersionInfo: vi.fn(async () => ({ version: "1.2.3-beta.1" })),
    });

    const result = await computeReleaseInfo(deps);

    expectOk(result);
    expect(result.snapshot.currentTag).toBeNull();
  });

  it("returns null currentTag when no version info exists at all", async () => {
    readReleaseStoreMock.mockResolvedValue(null);

    const result = await computeReleaseInfo(makeDeps());

    expectOk(result);
    expect(result.snapshot.currentTag).toBeNull();
  });
});

describe("channel and latest-tag selection", () => {
  const releases: GhRelease[] = [
    { tagName: "v0.19.0", isPrerelease: true },
    { tagName: "v0.18.2", isPrerelease: false },
    { tagName: "v0.18.1", isPrerelease: false },
  ];

  it("stable channel skips prereleases; absoluteLatestTag keeps the newest overall", async () => {
    getSettingMock.mockResolvedValue("stable");
    stubCommands({ ghReleases: releases });

    const result = await computeReleaseInfo(makeDeps());

    expectOk(result);
    expect(result.snapshot.channel).toBe("stable");
    expect(result.snapshot.latestTag).toBe("v0.18.2");
    expect(result.snapshot.absoluteLatestTag).toBe("v0.19.0");
  });

  it("preview channel takes the newest release including prereleases", async () => {
    getSettingMock.mockResolvedValue("preview");
    stubCommands({ ghReleases: releases });

    const result = await computeReleaseInfo(makeDeps());

    expectOk(result);
    expect(result.snapshot.channel).toBe("preview");
    expect(result.snapshot.latestTag).toBe("v0.19.0");
  });

  it("ignores non-semver tags such as old macOS preview builds", async () => {
    getSettingMock.mockResolvedValue("preview");
    stubCommands({
      ghReleases: [
        { tagName: "macos-acp-123-1", isPrerelease: true },
        ...releases,
      ],
    });

    const result = await computeReleaseInfo(makeDeps());

    expectOk(result);
    expect(result.snapshot.latestTag).toBe("v0.19.0");
    expect(result.snapshot.absoluteLatestTag).toBe("v0.19.0");
  });

  it("treats unknown channel settings as stable", async () => {
    getSettingMock.mockResolvedValue("nightly");
    stubCommands({ ghReleases: releases });

    const result = await computeReleaseInfo(makeDeps());

    expectOk(result);
    expect(result.snapshot.channel).toBe("stable");
    expect(result.snapshot.latestTag).toBe("v0.18.2");
  });

  it("stable channel with only prereleases yields null latestTag but keeps absoluteLatestTag", async () => {
    stubCommands({
      ghReleases: [{ tagName: "v0.19.0", isPrerelease: true }],
    });

    const result = await computeReleaseInfo(makeDeps());

    expectOk(result);
    expect(result.snapshot.latestTag).toBeNull();
    expect(result.snapshot.absoluteLatestTag).toBe("v0.19.0");
    expect(result.snapshot.updateAvailable).toBe(false);
  });

  it("fails instead of falling back to local git tags when release lookup fails", async () => {
    stubCommands({
      ghError: new Error("gh not authenticated"),
      gitTags: ["not-a-tag", "v0.18.9", "v0.18.8"],
    });

    const result = await computeReleaseInfo(makeDeps());

    expectFailed(result);
    expect(result.error).toMatch(/Unable to load GitHub Releases/);
  });
});

describe("updateAvailable classification", () => {
  it("is false when currentTag is unknown", async () => {
    readReleaseStoreMock.mockResolvedValue(null);
    stubCommands({ ghReleases: [{ tagName: "v0.19.0", isPrerelease: false }] });
    const deps = makeDeps();

    const result = await computeReleaseInfo(deps);

    expectOk(result);
    expect(result.snapshot.updateAvailable).toBe(false);
    expect(deps.fetchLatestReleaseMetadata).not.toHaveBeenCalled();
  });

  it("is false when the latest release equals the current tag", async () => {
    stubCommands({ ghReleases: [{ tagName: "v0.18.0", isPrerelease: false }] });

    const result = await computeReleaseInfo(makeDeps());

    expectOk(result);
    expect(result.snapshot.updateAvailable).toBe(false);
  });

  it("is false when the latest release is older than the current tag", async () => {
    stubCommands({ ghReleases: [{ tagName: "v0.17.0", isPrerelease: false }] });

    const result = await computeReleaseInfo(makeDeps());

    expectOk(result);
    expect(result.snapshot.updateAvailable).toBe(false);
  });

  it("is true for a newer release, loading its metadata without leaking the notes body", async () => {
    stubCommands({ ghReleases: [{ tagName: "v0.19.0", isPrerelease: false }] });
    const deps = makeDeps({
      fetchLatestReleaseMetadata: vi.fn(releaseMeta("plain notes")),
    });

    const result = await computeReleaseInfo(deps);

    expectOk(result);
    expect(result.snapshot.updateAvailable).toBe(true);
    expect(deps.fetchLatestReleaseMetadata).toHaveBeenCalledWith("v0.19.0");
    expect(result.snapshot.latestRelease).toEqual({
      tag: "v0.19.0",
      publishedAt: "2026-08-01T00:00:00Z",
      url: "https://github.com/owner/repo/releases/tag/v0.19.0",
    });
  });

  it("tolerates missing release metadata for an available update", async () => {
    stubCommands({ ghReleases: [{ tagName: "v0.19.0", isPrerelease: false }] });
    const deps = makeDeps({
      fetchLatestReleaseMetadata: vi.fn(async () => null),
    });

    const result = await computeReleaseInfo(deps);

    expectOk(result);
    expect(result.snapshot.updateAvailable).toBe(true);
    expect(result.snapshot.latestRelease).toBeNull();
  });
});

describe("progress emission", () => {
  it("emits the step sequence in order and always terminates with null", async () => {
    stubCommands({ ghReleases: [{ tagName: "v0.19.0", isPrerelease: false }] });
    const progress: Array<ReleaseProgress | null> = [];

    const result = await computeReleaseInfo(makeDeps(), {
      onProgress: (p) => progress.push(p),
    });

    expectOk(result);
    expect(progress.map((p) => (p === null ? "END" : p.step))).toEqual([
      "loading-release-list",
      "loading-release-notes",
      "END",
    ]);
  });

  it("returns a failed result and clears progress when the tag fetch fails", async () => {
    stubCommands({ fetchError: new Error("network unreachable") });
    const progress: Array<ReleaseProgress | null> = [];

    const result = await computeReleaseInfo(makeDeps(), {
      onProgress: (p) => progress.push(p),
    });

    expect(result).toEqual({
      ok: false,
      error: "Unable to load GitHub Releases: network unreachable",
    });
    expect(progress[progress.length - 1]).toBeNull();
  });
});

describe("resolveReleaseChannel", () => {
  it("prefers the saved setting over the installer default", () => {
    expect(resolveReleaseChannel("stable", "preview")).toBe("stable");
    expect(resolveReleaseChannel("preview", "stable")).toBe("preview");
  });

  it("falls back to the installer default, then stable", () => {
    expect(resolveReleaseChannel(null, "preview")).toBe("preview");
    expect(resolveReleaseChannel(null, undefined)).toBe("stable");
    expect(resolveReleaseChannel("nightly", "bogus")).toBe("stable");
  });

  it("reads the pre-1.0 'latest' value as preview", () => {
    expect(resolveReleaseChannel("latest", undefined)).toBe("preview");
  });
});
