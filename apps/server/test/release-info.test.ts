import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const { getSettingMock, readReleaseStoreMock, evaluateMock, runCommandMock } =
  vi.hoisted(() => ({
    getSettingMock: vi.fn(),
    readReleaseStoreMock: vi.fn(),
    evaluateMock: vi.fn(),
    runCommandMock: vi.fn(),
  }));

vi.mock("../src/db/settings.js", () => ({
  getSetting: getSettingMock,
}));

vi.mock("../src/release-store.js", () => ({
  readReleaseStore: readReleaseStoreMock,
}));

// Keep the real toSummary (pure manifest mapping) — only the tarball-touching
// evaluator itself is stubbed.
vi.mock("../src/update-migrations-evaluator.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/update-migrations-evaluator.js")
    >();
  return { ...actual, evaluatePendingMigrations: evaluateMock };
});

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: runCommandMock,
}));

import {
  computeReleaseInfo,
  type ComputeReleaseInfoDeps,
  type ComputeReleaseInfoResult,
  type ReleaseInfoSnapshot,
} from "../src/release-info.js";
import { compareSemver } from "../src/server/release-helpers.js";
import type { ReleaseProgress } from "../src/server/release-wire.js";
import type { PendingMigrationsResult } from "../src/update-migrations-evaluator.js";
import type { UpdateMigrationFile } from "../src/update-migrations.js";

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
    serverDir: "/srv",
    getGitHubRepo: vi.fn(async () => "owner/repo"),
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

/** Wrap metadata in the dispatch-update fence the way release notes carry it. */
function fencedBody(metadata: Record<string, unknown>): string {
  return `Release notes prose.\n\n\`\`\`dispatch-update\n${JSON.stringify(
    metadata
  )}\n\`\`\`\n`;
}

function releaseMeta(body: string | null, tag = "v0.19.0") {
  return async () => ({
    tag,
    publishedAt: "2026-08-01T00:00:00Z",
    url: `https://github.com/owner/repo/releases/tag/${tag}`,
    body,
  });
}

const noMigrations = (): PendingMigrationsResult => ({
  pending: [],
  all: [],
  appliedIds: new Set<string>(),
  errors: [],
});

function migrationFile(
  id: string,
  title: string,
  summary: string
): UpdateMigrationFile {
  return {
    filename: `0042-${id}.yaml`,
    order: 42,
    manifest: {
      id,
      title,
      summary,
      alreadySatisfied: { description: "not applicable" },
      instructions: ["run the step"],
      validation: { requiredChecks: [] },
      rollback: [],
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Defaults: healthy install on stable channel, no update available.
  readReleaseStoreMock.mockResolvedValue({ tag: "v0.18.0" });
  getSettingMock.mockResolvedValue(null);
  evaluateMock.mockImplementation(async () => noMigrations());
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
    { tagName: "v0.19.0-rc.1", isPrerelease: true },
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
    expect(result.snapshot.absoluteLatestTag).toBe("v0.19.0-rc.1");
  });

  it("latest channel takes the newest release including prereleases", async () => {
    getSettingMock.mockResolvedValue("latest");
    stubCommands({ ghReleases: releases });

    const result = await computeReleaseInfo(makeDeps());

    expectOk(result);
    expect(result.snapshot.channel).toBe("latest");
    expect(result.snapshot.latestTag).toBe("v0.19.0-rc.1");
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
      ghReleases: [{ tagName: "v0.19.0-rc.1", isPrerelease: true }],
    });

    const result = await computeReleaseInfo(makeDeps());

    expectOk(result);
    expect(result.snapshot.latestTag).toBeNull();
    expect(result.snapshot.absoluteLatestTag).toBe("v0.19.0-rc.1");
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
    expect(result.snapshot.assisted).toBeNull();
    expect(result.snapshot.assistedRequired).toBe(false);
  });
});

describe("assisted-update classification", () => {
  beforeEach(() => {
    stubCommands({ ghReleases: [{ tagName: "v0.19.0", isPrerelease: false }] });
  });

  it("marks assistedRequired for a required-mode release", async () => {
    const deps = makeDeps({
      fetchLatestReleaseMetadata: vi.fn(
        releaseMeta(
          fencedBody({
            mode: "required",
            title: "Manual step",
            summary: "Service definition changed.",
          })
        )
      ),
    });

    const result = await computeReleaseInfo(deps);

    expectOk(result);
    expect(result.snapshot.assisted?.mode).toBe("required");
    expect(result.snapshot.assistedRequired).toBe(true);
  });

  it("keeps assistedRequired false for recommended mode", async () => {
    const deps = makeDeps({
      fetchLatestReleaseMetadata: vi.fn(
        releaseMeta(
          fencedBody({
            mode: "recommended",
            title: "Nice to have",
            summary: "Optional cleanup.",
          })
        )
      ),
    });

    const result = await computeReleaseInfo(deps);

    expectOk(result);
    expect(result.snapshot.assisted?.mode).toBe("recommended");
    expect(result.snapshot.assistedRequired).toBe(false);
  });

  it("honors appliesFrom: installs below the threshold skip the assisted gate", async () => {
    // currentTag v0.18.0 < appliesFrom v0.18.5 → generic update path is fine.
    const deps = makeDeps({
      fetchLatestReleaseMetadata: vi.fn(
        releaseMeta(
          fencedBody({
            mode: "required",
            title: "Only for newer installs",
            summary: "Applies from v0.18.5.",
            appliesFrom: "v0.18.5",
          })
        )
      ),
    });

    const result = await computeReleaseInfo(deps);

    expectOk(result);
    expect(result.snapshot.assisted?.mode).toBe("required");
    expect(result.snapshot.assistedRequired).toBe(false);
  });

  it("fails hard when the assisted metadata fence is malformed", async () => {
    const progress: Array<ReleaseProgress | null> = [];
    const deps = makeDeps({
      fetchLatestReleaseMetadata: vi.fn(
        releaseMeta("```dispatch-update\n{not json\n```\n")
      ),
    });

    const result = await computeReleaseInfo(deps, {
      onProgress: (p) => progress.push(p),
    });

    expectFailed(result);
    expect(result.error).toMatch(/malformed assisted-update metadata/);
    // The finally block must still clear the progress channel.
    expect(progress[progress.length - 1]).toBeNull();
    // A metadata failure must short-circuit before the heavy tarball work.
    expect(evaluateMock).not.toHaveBeenCalled();
  });
});

describe("pending-migration evaluation", () => {
  beforeEach(() => {
    stubCommands({ ghReleases: [{ tagName: "v0.19.0", isPrerelease: false }] });
  });

  it("maps pending manifests to summaries and forces assistedRequired", async () => {
    const pendingFile = migrationFile(
      "backfill-things",
      "Backfill things",
      "Adds data."
    );
    evaluateMock.mockResolvedValue({
      pending: [pendingFile],
      all: [pendingFile],
      appliedIds: new Set<string>(),
      errors: [],
    } satisfies PendingMigrationsResult);

    const result = await computeReleaseInfo(makeDeps());

    expectOk(result);
    // toSummary must project down to exactly the wire summary — no manifest
    // internals (instructions, rollback, ...) may leak into the snapshot.
    expect(result.snapshot.pendingMigrations).toEqual([
      {
        id: "backfill-things",
        title: "Backfill things",
        summary: "Adds data.",
      },
    ]);
    expect(result.snapshot.assistedRequired).toBe(true);
    expect(result.snapshot.migrationsError).toBeNull();
  });

  it("joins per-file evaluation errors and forces assistedRequired", async () => {
    evaluateMock.mockResolvedValue({
      pending: [],
      all: [],
      appliedIds: new Set<string>(),
      errors: [
        { filename: "a.json", error: "bad schema" },
        { filename: "b.json", error: "unreadable" },
      ],
    } satisfies PendingMigrationsResult);

    const result = await computeReleaseInfo(makeDeps());

    expectOk(result);
    expect(result.snapshot.migrationsError).toBe(
      "a.json: bad schema; b.json: unreadable"
    );
    expect(result.snapshot.assistedRequired).toBe(true);
  });

  it("degrades an evaluator crash into migrationsError and assistedRequired, not a failed result", async () => {
    evaluateMock.mockRejectedValue(new Error("tarball download failed"));

    const result = await computeReleaseInfo(makeDeps());

    expectOk(result);
    expect(result.snapshot.migrationsError).toBe("tarball download failed");
    expect(result.snapshot.assistedRequired).toBe(true);
    expect(result.snapshot.pendingMigrations).toEqual([]);
  });

  it("skips migration evaluation entirely when no update is available", async () => {
    stubCommands({ ghReleases: [{ tagName: "v0.18.0", isPrerelease: false }] });

    const result = await computeReleaseInfo(makeDeps());

    expectOk(result);
    expect(evaluateMock).not.toHaveBeenCalled();
    expect(result.snapshot.migrationsError).toBeNull();
    expect(result.snapshot.assistedRequired).toBe(false);
  });
});

describe("progress emission", () => {
  it("emits the step sequence in order and always terminates with null", async () => {
    stubCommands({ ghReleases: [{ tagName: "v0.19.0", isPrerelease: false }] });
    evaluateMock.mockImplementation(async (_tag, ctx) => {
      ctx?.onProgress?.({ message: "Inspecting package" });
      ctx?.onProgress?.({
        message: "Downloading",
        bytesReceived: 512,
        totalBytes: 2048,
      });
      return noMigrations();
    });
    const progress: Array<ReleaseProgress | null> = [];

    const result = await computeReleaseInfo(makeDeps(), {
      onProgress: (p) => progress.push(p),
    });

    expectOk(result);
    expect(progress.map((p) => (p === null ? "END" : p.step))).toEqual([
      "loading-release-list",
      "loading-release-notes",
      "inspecting-release-package",
      "downloading-release-package",
      "END",
    ]);
    const download = progress.find(
      (p) => p?.step === "downloading-release-package"
    );
    expect(download).toMatchObject({
      bytesReceived: 512,
      totalBytes: 2048,
      detail: "Downloading",
    });
    const inspect = progress.find(
      (p) => p?.step === "inspecting-release-package"
    );
    expect(inspect).toMatchObject({
      bytesReceived: null,
      totalBytes: null,
    });
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
