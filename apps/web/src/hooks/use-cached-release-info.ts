import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
// The snapshot shape is defined once on the server and imported type-only —
// esbuild erases these imports, so nothing from the server reaches the web
// bundle.
import type { ReleaseInfoSnapshot } from "../../../server/src/release-info";

/**
 * Snapshot returned by GET /api/v1/release/cached-info — the in-memory
 * result of the most recent successful release check (manual or
 * automatic). Excludes the per-viewer admin enrichment that the live
 * /api/v1/release/info endpoint adds (unreleasedCount, commits, etc.) since
 * the snapshot is shared across UI clients.
 */
export type { ReleaseInfoSnapshot };

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
