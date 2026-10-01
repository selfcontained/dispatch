import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import type { GitHubReleaseListItem } from "./server/release-helpers.js";

import { getSetting } from "./db/settings.js";
import { readReleaseStore } from "./release-store.js";
import { errorMessage } from "./shared/lib/error-message.js";
import type { ReleaseProgress } from "./server/release-wire.js";

export const RELEASE_CHANNEL_KEY = "release_channel";
export const RELEASE_CHANNELS = ["stable", "preview"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

/**
 * Preview follows every published release (GitHub prereleases included);
 * stable follows only promoted ones. The saved setting wins; otherwise the
 * installer's DISPATCH_UPDATE_CHANNEL picks the default. "latest" is the
 * pre-1.0 name for preview.
 */
export function resolveReleaseChannel(
  saved: string | null,
  envDefault: string | undefined = process.env.DISPATCH_UPDATE_CHANNEL
): ReleaseChannel {
  for (const value of [saved, envDefault?.trim()]) {
    if (value === "stable") return "stable";
    if (value === "preview" || value === "latest") return "preview";
  }
  return "stable";
}

export async function readReleaseChannel(pool: Pool): Promise<ReleaseChannel> {
  return resolveReleaseChannel(await getSetting(pool, RELEASE_CHANNEL_KEY));
}

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
  computedAt: string;
};

export type ComputeReleaseInfoDeps = {
  pool: Pool;
  compareSemver: (a: string, b: string) => number;
  fetchGitHubReleases: () => Promise<GitHubReleaseListItem[]>;
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
 * tag and returns a snapshot.
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

  try {
    const currentTag = await deriveCurrentTag(deps);
    const channel = await readReleaseChannel(deps.pool);

    let latestTag: string | null = null;
    let absoluteLatestTag: string | null = null;
    try {
      emit({
        step: "loading-release-list",
        label: "Looking up latest release",
        detail: `Selecting the newest ${channel} release from GitHub.`,
      });
      const allReleases = await deps.fetchGitHubReleases();
      const artifactReleases = allReleases.filter(
        (release) =>
          release.hasDispatchArtifact && /^v\d+\.\d+\.\d+$/.test(release.tag)
      );
      absoluteLatestTag = artifactReleases[0]?.tag ?? null;
      latestTag =
        channel === "stable"
          ? (artifactReleases.find((r) => !r.prerelease)?.tag ?? null)
          : (artifactReleases[0]?.tag ?? null);
    } catch (err) {
      throw new Error(`Unable to load GitHub Releases: ${errorMessage(err)}`);
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
    if (latestTag && updateAvailable) {
      emit({
        step: "loading-release-notes",
        label: `Inspecting ${latestTag}`,
        detail: "Loading release metadata.",
      });
      const fullRelease = await deps.fetchLatestReleaseMetadata(latestTag);
      latestRelease = fullRelease
        ? {
            tag: fullRelease.tag,
            publishedAt: fullRelease.publishedAt,
            url: fullRelease.url,
          }
        : null;
    }

    return {
      ok: true,
      snapshot: {
        currentTag,
        channel,
        latestTag,
        absoluteLatestTag,
        updateAvailable,
        latestRelease,
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
