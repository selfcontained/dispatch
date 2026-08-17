import { useCallback, useEffect, useState } from "react";
import type { GitHubRelease } from "@/components/app/release-utils";
import { cleanError } from "@/components/app/release-utils";
import type { ReleaseInfo } from "@/hooks/use-release-stream";

export type UseReleaseAdminDataResult = {
  info: ReleaseInfo | null;
  infoLoading: boolean;
  infoError: string | null;
  lastCheckedAt: number | null;
  now: number;
  releases: GitHubRelease[];
  releasesLoading: boolean;
  promotingTag: string | null;
  confirmPromoteTag: string | null;
  promoteError: string | null;
  setConfirmPromoteTag: (tag: string | null) => void;
  refresh: () => void;
  promote: (tag: string) => Promise<void>;
};

/**
 * Data layer for the admin Releases page: the unreleased-commit info, the
 * recent GitHub releases list, and the promote-to-stable mutation that
 * writes back into that list. Kept out of the render shell so the page
 * components stay presentational.
 *
 * `streamClientId` comes from the release SSE stream so the server can push
 * info-progress events for the in-flight /release/info request.
 */
export function useReleaseAdminData(
  streamClientId: string
): UseReleaseAdminDataResult {
  const [info, setInfo] = useState<ReleaseInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [releases, setReleases] = useState<GitHubRelease[]>([]);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [promotingTag, setPromotingTag] = useState<string | null>(null);
  const [confirmPromoteTag, setConfirmPromoteTag] = useState<string | null>(
    null
  );
  const [promoteError, setPromoteError] = useState<string | null>(null);

  const fetchInfo = useCallback(async () => {
    setInfoLoading(true);
    setInfoError(null);
    try {
      // The client id lets the server stream info-progress events for
      // this request over the release SSE stream while git/GitHub run.
      const res = await fetch("/api/v1/release/info", {
        headers: { "x-dispatch-release-client-id": streamClientId },
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        setInfoError(cleanError(err.error ?? "Failed to load release info"));
        return;
      }
      setInfo((await res.json()) as ReleaseInfo);
      setLastCheckedAt(Date.now());
      setNow(Date.now());
    } catch (err) {
      setInfoError(
        err instanceof Error
          ? cleanError(err.message)
          : "Failed to load release info"
      );
    } finally {
      setInfoLoading(false);
    }
  }, [streamClientId]);

  const fetchReleases = useCallback(async () => {
    setReleasesLoading(true);
    try {
      const res = await fetch("/api/v1/releases");
      if (res.ok) {
        const data = (await res.json()) as { releases: GitHubRelease[] };
        setReleases(data.releases);
      }
    } catch {
      /* ignore */
    } finally {
      setReleasesLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    void fetchInfo();
    void fetchReleases();
  }, [fetchInfo, fetchReleases]);

  useEffect(() => {
    void fetchInfo();
    void fetchReleases();
  }, [fetchInfo, fetchReleases]);

  // Tick so the "checked Xs ago" label stays honest without refetching.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const promote = useCallback(async (tag: string) => {
    setPromotingTag(tag);
    setConfirmPromoteTag(null);
    setPromoteError(null);
    try {
      const res = await fetch("/api/v1/release/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag }),
      });
      if (res.ok) {
        setReleases((prev) =>
          prev.map((r) => (r.tag === tag ? { ...r, isPrerelease: false } : r))
        );
      } else {
        const err = (await res.json()) as { error?: string };
        setPromoteError(cleanError(err.error ?? `Failed to promote ${tag}`));
      }
    } catch (err) {
      setPromoteError(
        err instanceof Error
          ? cleanError(err.message)
          : `Failed to promote ${tag}`
      );
    } finally {
      setPromotingTag(null);
    }
  }, []);

  return {
    info,
    infoLoading,
    infoError,
    lastCheckedAt,
    now,
    releases,
    releasesLoading,
    promotingTag,
    confirmPromoteTag,
    promoteError,
    setConfirmPromoteTag,
    refresh,
    promote,
  };
}
