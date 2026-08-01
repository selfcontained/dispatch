import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import { getSetting } from "./db/settings.js";
import { readReleaseStore } from "./release-store.js";
import {
  inspectAssistedUpdateMetadata,
  isAssistedUpdateRequired,
  type AssistedUpdateMetadata,
} from "./release-metadata.js";
import {
  evaluatePendingMigrations,
  toSummary,
  type PendingMigrationSummary,
} from "./update-migrations-evaluator.js";
import { runCommand } from "./shared/lib/run-command.js";
import type { ReleaseProgress } from "./server/release-wire.js";

const RELEASE_CHANNEL_KEY = "release_channel";

export type ReleaseChannel = "stable" | "latest";

/**
 * Snapshot returned by computeReleaseInfo. Subset of the legacy
 * /api/v1/release/info response that's safe to share across UI clients —
 * intentionally excludes the admin-only fields (unreleasedCount, commits,
 * refMissing, isAdmin) since those are per-viewer enrichments. The route
 * handler computes those on the fly when the requesting user is admin.
 */
export type ReleaseInfoSnapshot = {
  currentTag: string | null;
  channel: ReleaseChannel;
  latestTag: string | null;
  absoluteLatestTag: string | null;
  updateAvailable: boolean;
  latestRelease: { tag: string; publishedAt: string; url: string } | null;
  assisted: AssistedUpdateMetadata | null;
  assistedRequired: boolean;
  pendingMigrations: PendingMigrationSummary[];
  migrationsError: string | null;
  computedAt: string;
};

export type ComputeReleaseInfoDeps = {
  pool: Pool;
  serverDir: string;
  getGitHubRepo: () => Promise<string>;
  parseGhJson: <T>(stdout: string) => T;
  compareSemver: (a: string, b: string) => number;
  getAppVersionInfo: () => Promise<{
    version: string | null;
  }>;
  fetchLatestReleaseMetadata: (tag: string) => Promise<{
    tag: string;
    publishedAt: string;
    url: string;
    body?: string | null;
  } | null>;
};

export type ComputeReleaseInfoOptions = {
  /** Optional sink for per-step progress (used by the route handler to
   *  stream into a per-client SSE channel). The auto-checker leaves this
   *  unset, since there's no human waiting on a progress bar. */
  onProgress?: (progress: ReleaseProgress | null) => void;
  /** Logger for structured warnings/info. */
  logger?:
    | FastifyBaseLogger
    | {
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
      };
};

export type ComputeReleaseInfoResult =
  | { ok: true; snapshot: ReleaseInfoSnapshot }
  | { ok: false; error: string };

/**
 * Pure-ish core of /api/v1/release/info. Fetches the channel-filtered latest
 * tag, classifies the release (assisted required/recommended/normal +
 * pending migrations), and returns a snapshot. Heavy: includes a tarball
 * download for migration evaluation when an update is available.
 *
 * The route handler wraps this with admin-only enrichment (unreleased
 * commits, refMissing) and per-client progress streaming. The auto-checker
 * calls this directly with no progress sink.
 */
export async function computeReleaseInfo(
  deps: ComputeReleaseInfoDeps,
  opts: ComputeReleaseInfoOptions = {}
): Promise<ComputeReleaseInfoResult> {
  const { onProgress, logger } = opts;
  const log = logger ?? null;
  const emit = (progress: ReleaseProgress | null): void => {
    onProgress?.(progress);
  };

  emit({
    step: "fetching-tags",
    label: "Fetching release tags",
    detail: "Checking origin for the latest available releases.",
  });

  try {
    await runCommand("git", [
      "-C",
      deps.serverDir,
      "fetch",
      "origin",
      "--tags",
      "--quiet",
    ]);

    const currentTag = await deriveCurrentTag(deps);
    const channelRaw = await getSetting(deps.pool, RELEASE_CHANNEL_KEY);
    const channel: ReleaseChannel =
      channelRaw === "latest" ? "latest" : "stable";

    let latestTag: string | null = null;
    let absoluteLatestTag: string | null = null;
    try {
      emit({
        step: "loading-release-list",
        label: "Looking up latest release",
        detail: `Selecting the newest ${channel} release from GitHub.`,
      });
      const repo = await deps.getGitHubRepo();
      const ghResult = await runCommand("gh", [
        "release",
        "list",
        "--repo",
        repo,
        "--limit",
        "10",
        "--json",
        "tagName,isPrerelease",
      ]);
      const allReleases = deps.parseGhJson<
        Array<{ tagName: string; isPrerelease: boolean }>
      >(ghResult.stdout);
      absoluteLatestTag = allReleases[0]?.tagName ?? null;
      latestTag =
        channel === "stable"
          ? (allReleases.find((r) => !r.isPrerelease)?.tagName ?? null)
          : (allReleases[0]?.tagName ?? null);
    } catch {
      const tagsResult = await runCommand("git", [
        "-C",
        deps.serverDir,
        "tag",
        "--sort=-version:refname",
      ]);
      const fallbackTag =
        tagsResult.stdout.split("\n").find((t) => t.startsWith("v")) ?? null;
      latestTag = fallbackTag;
      absoluteLatestTag = fallbackTag;
    }

    const updateAvailable = !!(
      currentTag &&
      latestTag &&
      deps.compareSemver(latestTag, currentTag) > 0
    );

    let latestRelease: {
      tag: string;
      publishedAt: string;
      url: string;
    } | null = null;
    let assisted: AssistedUpdateMetadata | null = null;
    let assistedMetadataError: string | null = null;
    if (latestTag && updateAvailable) {
      emit({
        step: "loading-release-notes",
        label: `Inspecting ${latestTag}`,
        detail: "Loading release metadata and assisted-update requirements.",
      });
      const fullRelease = await deps.fetchLatestReleaseMetadata(latestTag);
      latestRelease = fullRelease
        ? {
            tag: fullRelease.tag,
            publishedAt: fullRelease.publishedAt,
            url: fullRelease.url,
          }
        : null;
      const inspected = inspectAssistedUpdateMetadata(
        fullRelease?.body ?? null
      );
      if (inspected.state === "invalid") {
        assistedMetadataError = inspected.error;
      } else if (inspected.state === "valid") {
        assisted = inspected.metadata;
      }
    }

    if (assistedMetadataError) {
      return {
        ok: false,
        error: `Latest release has malformed assisted-update metadata: ${assistedMetadataError}`,
      };
    }

    let pendingMigrations: PendingMigrationSummary[] = [];
    let migrationsError: string | null = null;
    if (latestTag && updateAvailable) {
      log?.info?.(
        { tag: latestTag },
        "release-info: evaluating pending migrations"
      );
      try {
        const repo = await deps.getGitHubRepo();
        const evaluation = await evaluatePendingMigrations(latestTag, {
          repo,
          onProgress: ({ message, bytesReceived, totalBytes }) => {
            emit({
              step:
                bytesReceived !== undefined
                  ? "downloading-release-package"
                  : "inspecting-release-package",
              label:
                bytesReceived !== undefined
                  ? "Downloading release package"
                  : "Inspecting release package",
              detail: message,
              bytesReceived: bytesReceived ?? null,
              totalBytes: totalBytes ?? null,
            });
          },
        });
        pendingMigrations = evaluation.pending.map((m) =>
          toSummary(m.manifest)
        );
        if (evaluation.errors.length > 0) {
          migrationsError = evaluation.errors
            .map((e) => `${e.filename}: ${e.error}`)
            .join("; ");
        }
      } catch (err) {
        migrationsError =
          err instanceof Error ? err.message : "migration evaluation failed";
        log?.error?.(
          { err, tag: latestTag },
          "release-info: migration evaluation failed; falling back to assisted recommendation"
        );
      }
    }

    const assistedRequired =
      pendingMigrations.length > 0 ||
      (migrationsError !== null && updateAvailable) ||
      isAssistedUpdateRequired(assisted, currentTag);

    return {
      ok: true,
      snapshot: {
        currentTag,
        channel,
        latestTag,
        absoluteLatestTag,
        updateAvailable,
        latestRelease,
        assisted,
        assistedRequired,
        pendingMigrations,
        migrationsError,
        computedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  } finally {
    emit(null);
  }
}

async function deriveCurrentTag(
  deps: Pick<ComputeReleaseInfoDeps, "getAppVersionInfo">
): Promise<string | null> {
  const record = await readReleaseStore();
  if (record?.tag) return record.tag;
  const version = (await deps.getAppVersionInfo()).version?.trim() ?? null;
  return version && /^\d+\.\d+\.\d+$/.test(version) ? `v${version}` : null;
}
