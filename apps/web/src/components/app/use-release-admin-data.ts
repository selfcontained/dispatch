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
  promotionUrl: string | null;
  confirmPromoteTag: string | null;
  promoteError: string | null;
  setConfirmPromoteTag: (tag: string | null) => void;
  refresh: () => void;
  promote: (tag: string) => Promise<void>;
};

const PROMOTION_POLL_MS = 10_000;
const PROMOTION_TIMEOUT_MS = 10 * 60_000;

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
  // Promotion runs as a workflow: the request only starts it, and the row
  // turns stable once GitHub reports the release is no longer a prerelease.
  const [promotion, setPromotion] = useState<{
    tag: string;
    url: string | null;
    startedAt: number;
  } | null>(null);

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

  const fetchReleases = useCallback(async (): Promise<
    GitHubRelease[] | null
  > => {
    setReleasesLoading(true);
    try {
      const res = await fetch("/api/v1/releases");
      if (res.ok) {
        const data = (await res.json()) as { releases: GitHubRelease[] };
        setReleases(data.releases);
        return data.releases;
      }
    } catch {
      /* ignore */
    } finally {
      setReleasesLoading(false);
    }
    return null;
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
        const body = (await res.json()) as { workflowUrl?: string };
        setPromotion({
          tag,
          url: body.workflowUrl ?? null,
          startedAt: Date.now(),
        });
        return;
      }
      const err = (await res.json()) as { error?: string };
      setPromoteError(cleanError(err.error ?? `Failed to promote ${tag}`));
    } catch (err) {
      setPromoteError(
        err instanceof Error
          ? cleanError(err.message)
          : `Failed to promote ${tag}`
      );
    }
    setPromotingTag(null);
  }, []);

  useEffect(() => {
    if (!promotion) return;
    let cancelled = false;
    const check = async () => {
      const latest = await fetchReleases();
      if (cancelled) return;
      const release = latest?.find((r) => r.tag === promotion.tag);
      if (release && !release.isPrerelease) {
        setPromotion(null);
        setPromotingTag(null);
      } else if (Date.now() - promotion.startedAt > PROMOTION_TIMEOUT_MS) {
        setPromotion(null);
        setPromotingTag(null);
        setPromoteError(
          `${promotion.tag} is still a prerelease. Check the Promote Release workflow${
            promotion.url ? `: ${promotion.url}` : "."
          }`
        );
      }
    };
    void check();
    const timer = setInterval(() => void check(), PROMOTION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [promotion, fetchReleases]);

  return {
    info,
    infoLoading,
    infoError,
    lastCheckedAt,
    now,
    releases,
    releasesLoading,
    promotingTag,
    promotionUrl: promotion?.url ?? null,
    confirmPromoteTag,
    promoteError,
    setConfirmPromoteTag,
    refresh,
    promote,
  };
}
