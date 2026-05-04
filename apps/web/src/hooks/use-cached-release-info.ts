import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type {
  AssistedUpdateMetadata,
  PendingMigration,
  ReleaseChannel,
} from "@/hooks/use-release-stream";

/**
 * Snapshot returned by GET /api/v1/release/cached-info — the in-memory
 * result of the most recent successful release check (manual or
 * automatic). Excludes the per-viewer admin enrichment that the live
 * /api/v1/release/info endpoint adds (unreleasedCount, commits, etc.) since
 * the snapshot is shared across UI clients.
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
  pendingMigrations: PendingMigration[];
  migrationsError: string | null;
  computedAt: string;
};

export const CACHED_RELEASE_INFO_QUERY_KEY = [
  "release",
  "cached-info",
] as const;

type CachedInfoResponse = {
  snapshot: ReleaseInfoSnapshot | null;
};

export function useCachedReleaseInfo() {
  return useQuery<CachedInfoResponse>({
    queryKey: CACHED_RELEASE_INFO_QUERY_KEY,
    queryFn: () => api<CachedInfoResponse>("/api/v1/release/cached-info"),
    staleTime: Infinity,
  });
}
