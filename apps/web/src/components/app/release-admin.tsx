import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { OperationTakeover } from "@/components/app/release-manager";
import type { ReleaseInfo, ReleaseVersionType, UseReleaseStreamResult } from "@/hooks/use-release-stream";
import { cn } from "@/lib/utils";

type GitHubRelease = {
  tag: string;
  publishedAt: string;
  isPrerelease: boolean;
  url: string;
};

const VERSION_CONFIG: Record<ReleaseVersionType, {
  icon: typeof ShieldCheck;
  color: string;
  border: string;
  bg: string;
  hover: string;
}> = {
  patch: {
    icon: ShieldCheck,
    color: "text-status-working",
    border: "border-status-working/30",
    bg: "bg-status-working/10",
    hover: "hover:border-status-working/60 hover:bg-status-working/20"
  },
  minor: {
    icon: Sparkles,
    color: "text-status-done",
    border: "border-status-done/30",
    bg: "bg-status-done/10",
    hover: "hover:border-status-done/60 hover:bg-status-done/20"
  },
  major: {
    icon: Zap,
    color: "text-violet-400",
    border: "border-violet-500/30",
    bg: "bg-violet-500/10",
    hover: "hover:border-violet-500/60 hover:bg-violet-500/20"
  }
};

const CREATE_PHASES = ["preflight", "triggering", "watching", "done"] as const;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function cleanError(raw: string): string {
  const stderrMatch = raw.match(/stderr=(.+)$/s);
  if (stderrMatch) {
    const stderr = stderrMatch[1].trim();
    return stderr.replace(/^fatal:\s*/i, "");
  }
  return raw;
}

type ReleasesAdminProps = {
  stream: UseReleaseStreamResult;
};

export function ReleasesAdmin({ stream }: ReleasesAdminProps): JSX.Element {
  const { job, postRestartPolling, connectStream, setJob, status } = stream;

  const [info, setInfo] = useState<ReleaseInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [releases, setReleases] = useState<GitHubRelease[]>([]);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [promotingTag, setPromotingTag] = useState<string | null>(null);
  const [promoteError, setPromoteError] = useState<string | null>(null);

  const fetchInfo = useCallback(async () => {
    setInfoLoading(true);
    setInfoError(null);
    try {
      const res = await fetch("/api/v1/release/info");
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        setInfoError(cleanError(err.error ?? "Failed to load release info"));
        return;
      }
      setInfo((await res.json()) as ReleaseInfo);
    } catch (err) {
      setInfoError(err instanceof Error ? cleanError(err.message) : "Failed to load release info");
    } finally {
      setInfoLoading(false);
    }
  }, []);

  const fetchReleases = useCallback(async () => {
    setReleasesLoading(true);
    try {
      const res = await fetch("/api/v1/releases");
      if (res.ok) {
        const data = (await res.json()) as { releases: GitHubRelease[] };
        setReleases(data.releases);
      }
    } catch { /* ignore */ }
    finally { setReleasesLoading(false); }
  }, []);

  useEffect(() => {
    void fetchInfo();
    void fetchReleases();
  }, [fetchInfo, fetchReleases]);

  const handleRelease = async (versionType: ReleaseVersionType) => {
    setReleaseError(null);
    const res = await fetch("/api/v1/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionType })
    });
    if (!res.ok) {
      const err = (await res.json()) as { error?: string };
      setReleaseError(cleanError(err.error ?? "Failed to start release"));
      return;
    }
    setJob({ jobType: "create", versionType, phase: "preflight", startedAt: new Date().toISOString(), log: [], runUrl: null, tag: null, error: null });
    connectStream();
  };

  const handlePromote = async (tag: string) => {
    setPromotingTag(tag);
    setPromoteError(null);
    try {
      const res = await fetch("/api/v1/release/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag })
      });
      if (res.ok) {
        setReleases((prev) => prev.map((r) => r.tag === tag ? { ...r, isPrerelease: false } : r));
      } else {
        const err = (await res.json()) as { error?: string };
        setPromoteError(cleanError(err.error ?? `Failed to promote ${tag}`));
      }
    } catch (err) {
      setPromoteError(err instanceof Error ? cleanError(err.message) : `Failed to promote ${tag}`);
    } finally {
      setPromotingTag(null);
    }
  };

  // Only show takeover for create jobs
  const createJob = job?.jobType === "create" ? job : null;
  const isDone = createJob?.phase === "done";
  const isFailed = createJob?.phase === "failed";
  // Only show takeover for active or just-failed jobs, not stale done jobs
  // that persist in server memory from a previous release.
  const showTakeover = createJob !== null && !isDone;

  if (showTakeover) {
    return (
      <OperationTakeover
        job={createJob!}
        phasesOrder={[...CREATE_PHASES]}
        isDone={isDone}
        isFailed={isFailed}
        isRestarting={false}
        postRestartPolling={postRestartPolling}
        status={status}
        onDismiss={() => {
          setJob(null);
          setReleaseError(null);
          // Refresh data after a release was created
          void fetchInfo();
          void fetchReleases();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      {/* Unreleased commits */}
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">Unreleased changes</div>

        {infoLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading...
          </div>
        )}

        {infoError && (
          <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {infoError}
          </div>
        )}

        {info && !infoLoading && (
          <>
            {info.refMissing ? (
              <div className="rounded border border-status-waiting/30 bg-status-waiting/10 px-3 py-2 text-sm text-status-waiting">
                Deployed version <span className="font-mono">{info.currentTag ?? "unknown"}</span> not found in origin — commit count unavailable.
              </div>
            ) : info.unreleasedCount === 0 ? (
              <div className="text-sm text-muted-foreground">No unreleased commits on main</div>
            ) : (
              <div>
                <div className="mb-2 text-sm text-muted-foreground">
                  {info.unreleasedCount} unreleased {info.unreleasedCount === 1 ? "commit" : "commits"} on{" "}
                  <span className="font-mono">main</span>
                </div>
                <div className="flex flex-col gap-0.5 rounded border border-border bg-muted/20 p-2">
                  {info.commits.map((c) => (
                    <div key={c.sha} className="flex gap-2 py-0.5 text-xs">
                      <span className="shrink-0 font-mono text-muted-foreground">{c.sha}</span>
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
      {info && (info.refMissing || info.unreleasedCount > 0) && (
        <div>
          <div className="mb-3 text-[10px] uppercase tracking-widest text-muted-foreground">Create release</div>

          {releaseError && (
            <div className="mb-3 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {releaseError}
            </div>
          )}

          <div className="flex flex-col gap-2">
            {(["patch", "minor", "major"] as ReleaseVersionType[]).map((type) => {
              const { icon: Icon, color, border, bg, hover } = VERSION_CONFIG[type];
              return (
                <button
                  key={type}
                  onClick={() => void handleRelease(type)}
                  className={cn(
                    "flex flex-col items-center justify-center gap-2 rounded border py-4 transition-all",
                    border, bg, hover
                  )}
                >
                  <Icon className={cn("h-5 w-5", color)} />
                  <span className={cn("font-mono text-sm font-bold capitalize", color)}>{type}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="border-t border-border" />

      {/* Recent releases */}
      <div>
        <div className="mb-3 text-[10px] uppercase tracking-widest text-muted-foreground">Recent releases</div>

        {promoteError && (
          <div className="mb-3 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {promoteError}
          </div>
        )}

        {releasesLoading && releases.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading...
          </div>
        )}

        {releases.length > 0 && (
          <div className="flex flex-col gap-1">
            {releases.map((r) => (
              <div
                key={r.tag}
                className="flex items-center gap-3 rounded border border-border px-3 py-2.5"
              >
                <span className="font-mono text-sm font-semibold text-foreground">{r.tag}</span>
                <span className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                  r.isPrerelease
                    ? "bg-status-waiting/15 text-status-waiting"
                    : "bg-green-500/15 text-green-400"
                )}>
                  {r.isPrerelease ? "pre-release" : "stable"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatDate(r.publishedAt)}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  {r.isPrerelease && (
                    <button
                      onClick={() => void handlePromote(r.tag)}
                      disabled={promotingTag === r.tag}
                      className="rounded border border-green-500/30 bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-400 transition-all hover:border-green-500/60 hover:bg-green-500/20 disabled:opacity-50"
                    >
                      {promotingTag === r.tag ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        "Promote"
                      )}
                    </button>
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
