import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  XCircle,
  Zap,
} from "lucide-react";
import { OperationTakeover } from "@/components/app/release-operation-takeover";
import { cleanError, formatDate } from "@/components/app/release-utils";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import type {
  ReleaseInfo,
  ReleaseVersionType,
  UseReleaseStreamResult,
} from "@/hooks/use-release-stream";
import { cn } from "@/lib/utils";

type GitHubRelease = {
  tag: string;
  publishedAt: string;
  isPrerelease: boolean;
  url: string;
};

const VERSION_CONFIG: Record<
  ReleaseVersionType,
  {
    icon: typeof ShieldCheck;
    color: string;
    border: string;
    bg: string;
    hover: string;
  }
> = {
  patch: {
    icon: ShieldCheck,
    color: "text-status-working",
    border: "border-status-working/30",
    bg: "bg-status-working/10",
    hover: "hover:border-status-working/60 hover:bg-status-working/20",
  },
  minor: {
    icon: Sparkles,
    color: "text-status-done",
    border: "border-status-done/30",
    bg: "bg-status-done/10",
    hover: "hover:border-status-done/60 hover:bg-status-done/20",
  },
  major: {
    icon: Zap,
    color: "text-violet-400",
    border: "border-violet-500/30",
    bg: "bg-violet-500/10",
    hover: "hover:border-violet-500/60 hover:bg-violet-500/20",
  },
};

const CREATE_PHASES = ["preflight", "triggering", "watching", "done"] as const;

/**
 * Predict the tag the release workflow will cut for a version bump.
 * Exact stable tags only — the workflow bumps from main's package
 * version, so a prerelease-suffixed base would predict the wrong tag;
 * better to show no preview than a false promise.
 */
function bumpVersion(
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

function formatAgo(ts: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

type ReleasesAdminProps = {
  stream: UseReleaseStreamResult;
};

export function ReleasesAdmin({ stream }: ReleasesAdminProps): JSX.Element {
  const {
    job,
    postRestartPolling,
    connectStream,
    setJob,
    status,
    infoProgress,
    streamClientId,
  } = stream;

  const [info, setInfo] = useState<ReleaseInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [confirmType, setConfirmType] = useState<ReleaseVersionType | null>(
    null
  );
  const [showProgress, setShowProgress] = useState(false);
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

  useEffect(() => {
    void fetchInfo();
    void fetchReleases();
  }, [fetchInfo, fetchReleases]);

  // Tick so the "checked Xs ago" label stays honest without refetching.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const createJob = job?.jobType === "create" ? job : null;
  const isDone = createJob?.phase === "done";
  const isFailed = createJob?.phase === "failed";
  const releaseInFlight = createJob !== null && !isDone && !isFailed;

  // Distinguish a release we watched run from a stale done job that
  // persists in server memory and arrives via the stream snapshot.
  // State (not a ref): the done banner is rendered from this value, and
  // stream events can land back-to-back so the done render may commit
  // before a ref written in an effect would be visible.
  const [watchedRelease, setWatchedRelease] = useState(false);
  useEffect(() => {
    if (releaseInFlight) setWatchedRelease(true);
  }, [releaseInFlight]);

  // When a release we watched finishes, refresh so the just-released
  // commits leave the unreleased list without a manual reload.
  const handledDoneRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      isDone &&
      watchedRelease &&
      createJob &&
      handledDoneRef.current !== createJob.startedAt
    ) {
      handledDoneRef.current = createJob.startedAt;
      void fetchInfo();
      void fetchReleases();
    }
  }, [isDone, watchedRelease, createJob, fetchInfo, fetchReleases]);

  const handleRelease = async (versionType: ReleaseVersionType) => {
    setReleaseError(null);
    setConfirmType(null);
    const res = await fetch("/api/v1/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionType }),
    });
    if (!res.ok) {
      const err = (await res.json()) as { error?: string };
      setReleaseError(cleanError(err.error ?? "Failed to start release"));
      return;
    }
    setJob({
      jobType: "create",
      versionType,
      phase: "preflight",
      startedAt: new Date().toISOString(),
      log: [],
      runUrl: null,
      tag: null,
      error: null,
      progress: null,
    });
    connectStream();
    setShowProgress(true);
  };

  const handlePromote = async (tag: string) => {
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
  };

  // The most recent GitHub release (prereleases included) is what the
  // release workflow bumps from; fall back to the deployed tag.
  const bumpBase = releases[0]?.tag ?? info?.currentTag ?? null;

  const dismissJob = () => {
    setJob(null);
    setShowProgress(false);
    setWatchedRelease(false);
    setReleaseError(null);
  };

  // Expanded progress view — jump in and out freely; the release keeps
  // running server-side either way.
  if (showProgress && createJob) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-white/[0.12] px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowProgress(false)}
            className="gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to releases
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <OperationTakeover
            job={createJob}
            phasesOrder={[...CREATE_PHASES]}
            isDone={isDone}
            isFailed={isFailed}
            isRestarting={false}
            postRestartPolling={postRestartPolling}
            status={status}
            onDismiss={dismissJob}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      {/* In-flight / finished release banner — page stays usable */}
      {createJob && releaseInFlight && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2.5 text-sm text-blue-300">
          <ActivityBars size={14} />
          <span>
            Releasing{" "}
            <span className="font-semibold capitalize">
              {createJob.versionType}
            </span>
            {createJob.tag && (
              <>
                {" "}
                <span className="font-mono">{createJob.tag}</span>
              </>
            )}{" "}
            — {createJob.phase}
          </span>
          <Button
            size="sm"
            variant="ghost-primary"
            className="ml-auto shrink-0"
            onClick={() => setShowProgress(true)}
          >
            View progress
          </Button>
        </div>
      )}
      {createJob && isFailed && (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <XCircle className="h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate">
            Release failed
            {createJob.error ? `: ${cleanError(createJob.error)}` : ""}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="ghost-primary"
              onClick={() => setShowProgress(true)}
            >
              Details
            </Button>
            <Button size="sm" variant="ghost" onClick={dismissJob}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {createJob && isDone && watchedRelease && (
        <div className="flex items-center gap-3 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2.5 text-sm text-green-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>
            Released{" "}
            <span className="font-mono font-semibold">{createJob.tag}</span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto shrink-0"
            onClick={dismissJob}
          >
            Dismiss
          </Button>
        </div>
      )}

      {/* Unreleased commits */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Unreleased changes
          </div>
          <div className="flex items-center gap-2">
            {lastCheckedAt !== null && !infoLoading && (
              <span className="text-[10px] text-muted-foreground">
                Checked {formatAgo(lastCheckedAt, now)}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh unreleased changes"
              title="Refresh"
              onClick={() => {
                void fetchInfo();
                void fetchReleases();
              }}
              disabled={infoLoading}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", infoLoading && "animate-spin")}
              />
            </Button>
          </div>
        </div>

        {infoLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ActivityBars size={14} />
            {infoProgress?.label ?? "Loading..."}
            {infoProgress?.detail && (
              <span className="text-muted-foreground/70">
                {infoProgress.detail}
              </span>
            )}
          </div>
        )}

        {infoError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {infoError}
          </div>
        )}

        {info && !infoLoading && (
          <>
            {info.unreleasedFetchError ? (
              <div className="rounded-lg border border-status-waiting/30 bg-status-waiting/10 px-3 py-2 text-sm text-status-waiting">
                Couldn't refresh <span className="font-mono">origin/main</span>{" "}
                — unreleased commit info is unavailable, not necessarily zero.
                <div className="mt-1 break-words font-mono text-xs opacity-80">
                  {cleanError(info.unreleasedFetchError)}
                </div>
              </div>
            ) : info.refMissing ? (
              <div className="rounded-lg border border-status-waiting/30 bg-status-waiting/10 px-3 py-2 text-sm text-status-waiting">
                Deployed version{" "}
                <span className="font-mono">
                  {info.currentTag ?? "unknown"}
                </span>{" "}
                not found in origin — commit count unavailable.
              </div>
            ) : info.unreleasedCount === 0 ? (
              <div className="text-sm text-muted-foreground">
                No unreleased commits on main
              </div>
            ) : (
              <div>
                <div className="mb-2 text-sm text-muted-foreground">
                  {info.unreleasedCount} unreleased{" "}
                  {info.unreleasedCount === 1 ? "commit" : "commits"} on{" "}
                  <span className="font-mono">main</span>
                </div>
                <div className="flex flex-col gap-0.5 rounded-lg border border-white/[0.12] bg-white/[0.04] p-3">
                  {info.commits.map((c) => (
                    <div key={c.sha} className="flex gap-2 py-0.5 text-xs">
                      <span className="shrink-0 font-mono text-muted-foreground">
                        {c.sha}
                      </span>
                      <span className="text-foreground">{c.subject}</span>
                    </div>
                  ))}
                  {info.unreleasedCount > info.commits.length && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      +{info.unreleasedCount - info.commits.length} more
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Create release */}
      {info &&
        (info.refMissing ||
          Boolean(info.unreleasedFetchError) ||
          info.unreleasedCount > 0) && (
          <div>
            <div className="mb-3 text-[10px] uppercase tracking-widest text-muted-foreground">
              Create release
            </div>

            {releaseError && (
              <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {releaseError}
              </div>
            )}

            <div className="flex flex-col gap-2">
              {(["patch", "minor", "major"] as ReleaseVersionType[]).map(
                (type) => {
                  const {
                    icon: Icon,
                    color,
                    border,
                    bg,
                    hover,
                  } = VERSION_CONFIG[type];
                  const nextTag = bumpVersion(bumpBase, type);
                  return (
                    <button
                      key={type}
                      onClick={() =>
                        setConfirmType((prev) => (prev === type ? null : type))
                      }
                      disabled={releaseInFlight}
                      className={cn(
                        "flex flex-col items-center justify-center gap-1.5 rounded-lg border py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-all disabled:cursor-not-allowed disabled:opacity-50",
                        border,
                        bg,
                        !releaseInFlight && hover,
                        confirmType === type && "ring-1 ring-white/30"
                      )}
                    >
                      <Icon className={cn("h-5 w-5", color)} />
                      <span
                        className={cn(
                          "font-mono text-sm font-bold capitalize",
                          color
                        )}
                      >
                        {type}
                      </span>
                      {nextTag && (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          → {nextTag}
                        </span>
                      )}
                    </button>
                  );
                }
              )}
            </div>

            {confirmType && !releaseInFlight && (
              <div className="mt-3 flex flex-col gap-3 rounded-lg border border-white/[0.12] bg-white/[0.04] p-3 sm:flex-row sm:items-center">
                <span className="text-sm text-foreground">
                  Trigger a{" "}
                  <span className="font-semibold capitalize">
                    {confirmType}
                  </span>{" "}
                  release
                  {bumpVersion(bumpBase, confirmType) && (
                    <>
                      {" "}
                      as{" "}
                      <span className="font-mono font-semibold">
                        {bumpVersion(bumpBase, confirmType)}
                      </span>
                    </>
                  )}
                  ? This runs the release workflow against{" "}
                  <span className="font-mono">main</span>.
                </span>
                <div className="flex shrink-0 items-center gap-2 sm:ml-auto">
                  <Button
                    size="sm"
                    onClick={() => void handleRelease(confirmType)}
                  >
                    Release
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmType(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

      <div className="border-t border-white/[0.12]" />

      {/* Recent releases */}
      <div>
        <div className="mb-3 text-[10px] uppercase tracking-widest text-muted-foreground">
          Recent releases
        </div>

        {promoteError && (
          <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {promoteError}
          </div>
        )}

        {releasesLoading && releases.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ActivityBars size={14} />
            Loading...
          </div>
        )}

        {releases.length > 0 && (
          <div className="flex flex-col gap-1">
            {releases.map((r) => (
              <div
                key={r.tag}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-white/[0.12] bg-white/[0.04] px-3 py-2.5"
              >
                <span className="font-mono text-sm font-semibold text-foreground">
                  {r.tag}
                </span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                    r.isPrerelease
                      ? "bg-status-waiting/15 text-status-waiting"
                      : "bg-green-500/15 text-green-400"
                  )}
                >
                  {r.isPrerelease ? "pre-release" : "stable"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatDate(r.publishedAt)}
                </span>
                <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
                  {r.isPrerelease && confirmPromoteTag !== r.tag && (
                    <Button
                      size="sm"
                      variant="ghost-primary"
                      onClick={() => setConfirmPromoteTag(r.tag)}
                      disabled={promotingTag === r.tag}
                    >
                      {promotingTag === r.tag ? (
                        <ActivityBars size={12} />
                      ) : (
                        "Promote"
                      )}
                    </Button>
                  )}
                  {r.isPrerelease && confirmPromoteTag === r.tag && (
                    <>
                      <span className="text-xs text-muted-foreground">
                        Mark stable + latest?
                      </span>
                      <Button
                        size="sm"
                        variant="ghost-primary"
                        onClick={() => void handlePromote(r.tag)}
                      >
                        Confirm
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmPromoteTag(null)}
                      >
                        Cancel
                      </Button>
                    </>
                  )}
                  {!r.isPrerelease && (
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-500/50" />
                  )}
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}

        {!releasesLoading && releases.length === 0 && (
          <div className="text-sm text-muted-foreground">No releases found</div>
        )}
      </div>
    </div>
  );
}
