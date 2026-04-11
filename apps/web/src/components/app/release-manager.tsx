import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Loader2, RefreshCw, Trash2, XCircle } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { OperationLog, PhaseProgress } from "@/components/app/release-shared";
import { type ReleaseChannel, type ReleaseInfo, type ReleaseJob, type UseReleaseStreamResult } from "@/hooks/use-release-stream";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type AppVersionInfo = {
  releaseTag: string | null;
  version: string | null;
  gitSha: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
};

const UPDATE_PHASES = ["fetching", "deploying", "restarting", "done"] as const;

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

type UpdatesSectionProps = {
  stream: UseReleaseStreamResult;
};

export function UpdatesSection({ stream }: UpdatesSectionProps): JSX.Element {
  const { status, job, postRestartPolling, connectStream, setJob } = stream;

  const [versionInfo, setVersionInfo] = useState<AppVersionInfo | null>(null);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [channel, setChannel] = useState<ReleaseChannel>("stable");
  const [channelSaving, setChannelSaving] = useState(false);
  const [info, setInfo] = useState<ReleaseInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  // Fetch version info + channel on mount
  useEffect(() => {
    let cancelled = false;
    void api<AppVersionInfo>("/api/v1/app/version")
      .then((data) => { if (!cancelled) setVersionInfo(data); })
      .catch(() => {});
    void api<{ channel: ReleaseChannel }>("/api/v1/release/channel")
      .then((data) => { if (!cancelled) setChannel(data.channel); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleChannelChange = useCallback(async (value: ReleaseChannel) => {
    setChannel(value);
    setChannelSaving(true);
    try {
      await api("/api/v1/release/channel", {
        method: "POST",
        body: JSON.stringify({ channel: value }),
      });
      // Reset update info since channel changed
      setInfo(null);
    } catch {
      // revert on error
      setChannel((prev) => prev === "stable" ? "latest" : "stable");
    } finally {
      setChannelSaving(false);
    }
  }, []);

  const handleCheckForUpdates = async () => {
    setInfoLoading(true);
    setInfoError(null);
    setInfo(null);
    try {
      const res = await fetch("/api/v1/release/info");
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        setInfoError(cleanError(err.error ?? "Failed to check for updates"));
        return;
      }
      setInfo((await res.json()) as ReleaseInfo);
    } catch (err) {
      setInfoError(err instanceof Error ? cleanError(err.message) : "Failed to check for updates");
    } finally {
      setInfoLoading(false);
    }
  };

  const handleUpdate = async (tag: string) => {
    setUpdateError(null);
    const res = await fetch("/api/v1/release/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag })
    });
    if (!res.ok) {
      const err = (await res.json()) as { error?: string };
      setUpdateError(cleanError(err.error ?? "Failed to start update"));
      return;
    }
    setJob({ jobType: "update", versionType: null, phase: "fetching", startedAt: new Date().toISOString(), log: [], runUrl: null, tag, error: null });
    connectStream();
  };

  const handleReload = useCallback(() => {
    setReloading(true);
    window.location.reload();
  }, []);

  const handleClearCacheAndReload = useCallback(async () => {
    setReloading(true);
    try {
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((r) => r.unregister()));
      }
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      window.location.reload();
    } catch {
      window.location.reload();
    }
  }, []);

  // Only show takeover for update jobs
  const updateJob = job?.jobType === "update" ? job : null;
  const isDone = updateJob?.phase === "done" || (!postRestartPolling && updateJob?.phase === "restarting" && status?.tag === updateJob?.tag);
  const isFailed = updateJob?.phase === "failed";
  const isRestarting = updateJob?.phase === "restarting" || (updateJob !== null && postRestartPolling);
  const showTakeover = updateJob !== null;

  if (showTakeover) {
    return (
      <OperationTakeover
        job={updateJob!}
        phasesOrder={[...UPDATE_PHASES]}
        isDone={isDone}
        isFailed={isFailed}
        isRestarting={isRestarting}
        postRestartPolling={postRestartPolling}
        status={status}
        onDismiss={() => { setJob(null); setInfo(null); setUpdateError(null); }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      {/* Current version */}
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">Current version</div>
        {status ? (
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xl font-bold text-foreground">{status.tag ?? "unknown"}</span>
            {status.deployedAt ? (
              <span className="text-xs text-muted-foreground">{formatDate(status.deployedAt)}</span>
            ) : null}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">Loading...</span>
        )}

        {versionInfo && (
          <div className="mt-3 grid gap-2 rounded border border-border p-3 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Release tag</span>
              <span className="font-mono">{versionInfo.releaseTag ?? "unreleased"}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Package version</span>
              <span className="font-mono">{versionInfo.version ?? "unknown"}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Git SHA</span>
              <span className="font-mono">{versionInfo.gitSha ?? "unavailable"}</span>
            </div>
          </div>
        )}
      </div>

      {/* Release notes — collapsible */}
      {versionInfo?.releaseNotes && (
        <div>
          <button
            onClick={() => setNotesExpanded(!notesExpanded)}
            className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
          >
            {notesExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Release notes
            {versionInfo.releaseUrl ? (
              <a
                className="ml-2 inline-flex items-center gap-1 text-xs normal-case tracking-normal text-blue-400 hover:underline"
                href={versionInfo.releaseUrl}
                rel="noopener noreferrer"
                target="_blank"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-3 w-3" />
                GitHub
              </a>
            ) : null}
          </button>
          {notesExpanded && (
            <div className="mt-2 rounded border border-border p-3">
              <div className="max-h-56 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                {versionInfo.releaseNotes}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="border-t border-border" />

      {/* Release channel */}
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">Release channel</div>
        <p className="mb-3 text-sm text-muted-foreground">
          Choose which releases this instance follows.
        </p>
        <div className={cn("inline-flex rounded border border-border", channelSaving && "opacity-50 pointer-events-none")}>
          {(["stable", "latest"] as ReleaseChannel[]).map((ch) => (
            <button
              key={ch}
              onClick={() => void handleChannelChange(ch)}
              className={cn(
                "px-4 py-1.5 text-sm font-medium capitalize transition-colors",
                channel === ch
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
                ch === "stable" && "rounded-l border-r border-border",
                ch === "latest" && "rounded-r"
              )}
            >
              {ch}
            </button>
          ))}
        </div>
      </div>

      {/* Check for updates */}
      <div className="flex flex-col gap-4">
        {!info && !infoLoading && (
          <button
            onClick={() => void handleCheckForUpdates()}
            className="self-start rounded border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            Check for updates
          </button>
        )}

        {infoLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking...
          </div>
        )}

        {infoError && (
          <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {infoError}
          </div>
        )}

        {info && (
          <>
            {info.updateAvailable && info.latestTag ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <ArrowDownToLine className="h-4 w-4 text-blue-400" />
                  <span className="text-sm text-foreground">
                    <span className="font-mono font-semibold">{info.latestTag}</span> available
                  </span>
                  {info.latestRelease?.publishedAt && (
                    <span className="text-xs text-muted-foreground">
                      · {formatDate(info.latestRelease.publishedAt)}
                    </span>
                  )}
                </div>

                {info.latestRelease?.url && (
                  <a
                    href={info.latestRelease.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 self-start text-xs text-blue-400 hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    View release on GitHub
                  </a>
                )}

                {updateError && (
                  <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {updateError}
                  </div>
                )}

                <button
                  onClick={() => void handleUpdate(info.latestTag!)}
                  className="self-start rounded border border-blue-500/30 bg-blue-500/10 px-4 py-2 text-sm font-medium text-blue-400 transition-all hover:border-blue-500/60 hover:bg-blue-500/20"
                >
                  Update to {info.latestTag}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                Up to date
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t border-border" />

      {/* Reload */}
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">Reload</div>
        <p className="mb-3 text-sm text-muted-foreground">
          Reload the app to pick up the latest version.
        </p>
        <div className="inline-flex items-stretch">
          <button
            onClick={handleReload}
            disabled={reloading}
            className="inline-flex items-center gap-2 rounded-l border border-r-0 border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", reloading && "animate-spin")} />
            {reloading ? "Reloading..." : "Reload"}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                disabled={reloading}
                className="inline-flex items-center rounded-r border border-border px-1.5 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-50"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => void handleClearCacheAndReload()}
                className="flex items-center whitespace-nowrap text-muted-foreground"
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Clear cache & reload
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

// --- Operation takeover (shared layout for update/create flows) ---

type OperationTakeoverProps = {
  job: ReleaseJob;
  phasesOrder: string[];
  isDone: boolean;
  isFailed: boolean;
  isRestarting: boolean;
  postRestartPolling: boolean;
  status: { tag: string | null; deployedAt: string | null } | null;
  onDismiss: () => void;
};

export function OperationTakeover({
  job,
  phasesOrder,
  isDone,
  isFailed,
  isRestarting,
  postRestartPolling,
  status,
  onDismiss,
}: OperationTakeoverProps): JSX.Element {
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [job.log]);

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* Left column — controls */}
      <div className="flex md:w-[360px] shrink-0 flex-col gap-6 overflow-y-auto border-b md:border-b-0 md:border-r border-border p-4 md:p-6">
        <PhaseProgress
          job={job}
          phasesOrder={phasesOrder}
          isFailed={isFailed}
          isRestarting={isRestarting}
        />

        {job.runUrl && (
          <a
            href={job.runUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 self-start text-xs text-blue-400 hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            View GitHub Actions run
          </a>
        )}

        {isDone && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded border border-green-500/30 bg-green-500/10 px-3 py-2.5 text-sm text-green-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>
                {job.jobType === "update" ? "Updated to" : "Released"}{" "}
                <span className="font-mono font-semibold">{job.tag ?? status?.tag}</span>
              </span>
            </div>
            <button
              onClick={onDismiss}
              className="self-start rounded border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              Done
            </button>
          </div>
        )}

        {isFailed && (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{job.error ? cleanError(job.error) : "Operation failed"}</span>
            </div>
            <button
              onClick={onDismiss}
              className="self-start rounded border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {/* Right column — log */}
      <OperationLog logRef={logRef} job={job} isRestarting={isRestarting} postRestartPolling={postRestartPolling} />
    </div>
  );
}
