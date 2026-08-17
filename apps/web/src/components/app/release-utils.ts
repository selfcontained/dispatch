import type {
  ReleaseInfo,
  ReleaseJob,
  ReleaseProgress,
  ReleaseVersionType,
} from "@/hooks/use-release-stream";
import type { ReleaseInfoSnapshot } from "@/hooks/use-cached-release-info";
import { formatBytes } from "../../../../server/src/shared/lib/format-bytes";

export { formatBytes };

export type AppVersionInfo = {
  releaseTag: string | null;
  version: string | null;
  gitSha: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
};

export type GitHubRelease = {
  tag: string;
  publishedAt: string;
  isPrerelease: boolean;
  url: string;
};

export const UPDATE_PHASES = [
  "fetching",
  "deploying",
  "restarting",
  "done",
] as const;

export const CREATE_PHASES = [
  "preflight",
  "triggering",
  "watching",
  "done",
] as const;

/**
 * Predict the tag the release workflow will cut for a version bump.
 * Exact stable tags only — the workflow bumps from main's package
 * version, so a prerelease-suffixed base would predict the wrong tag;
 * better to show no preview than a false promise.
 */
export function bumpVersion(
  base: string | null,
  type: ReleaseVersionType
): string | null {
  if (!base) return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (type === "major") return `v${major + 1}.0.0`;
  if (type === "minor") return `v${major}.${minor + 1}.0`;
  return `v${major}.${minor}.${patch + 1}`;
}

export function formatAgo(ts: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function cleanError(raw: string): string {
  const stderrMatch = raw.match(/stderr=(.+)$/s);
  if (stderrMatch) {
    const stderr = stderrMatch[1].trim();
    return stderr.replace(/^fatal:\s*/i, "");
  }
  return raw;
}

export function formatProgressLabel(job: ReleaseJob): string | null {
  const progress = job.progress;
  if (!progress) return null;

  if (
    progress.bytesReceived !== null &&
    progress.bytesReceived !== undefined &&
    progress.totalBytes !== null &&
    progress.totalBytes !== undefined &&
    progress.totalBytes > 0
  ) {
    const percent = Math.min(
      100,
      Math.round((progress.bytesReceived / progress.totalBytes) * 100)
    );
    return `${percent}% · ${formatBytes(progress.bytesReceived)} / ${formatBytes(
      progress.totalBytes
    )}`;
  }

  if (
    progress.bytesReceived !== null &&
    progress.bytesReceived !== undefined &&
    progress.bytesReceived > 0
  ) {
    return `${formatBytes(progress.bytesReceived)} downloaded`;
  }

  return null;
}

export function formatInlineProgress(
  progress: ReleaseProgress | null
): string | null {
  if (!progress) return null;

  const progressParts = [progress.label];
  if (
    progress.bytesReceived !== null &&
    progress.bytesReceived !== undefined &&
    progress.totalBytes !== null &&
    progress.totalBytes !== undefined &&
    progress.totalBytes > 0
  ) {
    const percent = Math.min(
      100,
      Math.round((progress.bytesReceived / progress.totalBytes) * 100)
    );
    progressParts.push(
      `${percent}% · ${formatBytes(progress.bytesReceived)} / ${formatBytes(
        progress.totalBytes
      )}`
    );
  } else if (
    progress.bytesReceived !== null &&
    progress.bytesReceived !== undefined &&
    progress.bytesReceived > 0
  ) {
    progressParts.push(`${formatBytes(progress.bytesReceived)} downloaded`);
  }

  return progressParts.join(" · ");
}

export function progressPercent(
  progress: ReleaseProgress | null
): number | null {
  if (
    !progress ||
    progress.bytesReceived === null ||
    progress.bytesReceived === undefined ||
    progress.totalBytes === null ||
    progress.totalBytes === undefined ||
    progress.totalBytes <= 0
  ) {
    return null;
  }
  return Math.min(100, (progress.bytesReceived / progress.totalBytes) * 100);
}

/**
 * True when the standard updater would need an explicit force to run — the
 * release either demands the assisted flow or carries pending migrations.
 */
export function isForceRequired(
  info: ReleaseInfo | ReleaseInfoSnapshot
): boolean {
  return (
    info.assistedRequired === true || (info.pendingMigrations?.length ?? 0) > 0
  );
}

/** True when the agent-assisted update should be the primary offered action. */
export function isAssistedPreferred(
  info: ReleaseInfo | ReleaseInfoSnapshot
): boolean {
  return isForceRequired(info) || info.assisted?.mode === "recommended";
}

export function describeForceTriggers(
  info: ReleaseInfo | ReleaseInfoSnapshot
): string {
  const migrationCount = info.pendingMigrations?.length ?? 0;
  if (migrationCount > 0) {
    return `has ${migrationCount} complex update step${
      migrationCount === 1 ? "" : "s"
    }; safer with the agent`;
  }
  if (info.assisted?.mode === "required") {
    return "needs the agent for a safe update";
  }
  if (info.migrationsError) {
    return "couldn't be checked for complex update steps";
  }
  return "is gated by the assisted-update flow";
}
