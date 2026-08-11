import type {
  ReleaseInfo,
  ReleaseJob,
  ReleaseProgress,
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

export const UPDATE_PHASES = [
  "fetching",
  "deploying",
  "restarting",
  "done",
] as const;

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
