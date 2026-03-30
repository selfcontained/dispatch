import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, CheckCircle2, ExternalLink, Loader2, ShieldCheck, Sparkles, Zap, XCircle } from "lucide-react";
import { recordReleaseManagerPollFire } from "@/lib/energy-metrics";

import { cn } from "@/lib/utils";

type ReleaseVersionType = "patch" | "minor" | "major";
type ReleasePhase = "preflight" | "triggering" | "watching" | "fetching" | "deploying" | "restarting" | "done" | "failed";
type ReleaseJobType = "create" | "update";

type ReleaseStatus = {
  tag: string | null;
  deployedAt: string | null;
};

type ReleaseInfo = {
  currentTag: string | null;
  isAdmin: boolean;
  latestTag: string | null;
  updateAvailable: boolean;
  latestRelease: { tag: string; publishedAt: string; url: string } | null;
  unreleasedCount: number;
  commits: Array<{ sha: string; subject: string }>;
  refMissing?: boolean;
};

type ReleaseJob = {
  jobType: ReleaseJobType;
  versionType: ReleaseVersionType | null;
  phase: ReleasePhase;
  startedAt: string;
  log: string[];
  runUrl: string | null;
  tag: string | null;
  error: string | null;
};

type ReleaseStreamEvent =
  | { type: "snapshot"; job: ReleaseJob | null }
  | { type: "log"; line: string }
  | { type: "log.replace"; line: string }
  | { type: "log.rewind"; count: number }
  | { type: "phase"; phase: ReleasePhase; error?: string }
  | { type: "runUrl"; url: string }
  | { type: "tag"; tag: string };

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

const PHASE_LABELS: Record<ReleasePhase, string> = {
  preflight: "Pre-flight",
  triggering: "Trigger workflow",
  watching: "CI running",
  fetching: "Fetching",
  deploying: "Deploying",
  restarting: "Restarting",
  done: "Complete",
  failed: "Failed"
};

const CREATE_PHASES: ReleasePhase[] = ["preflight", "triggering", "watching", "deploying", "restarting", "done"];
const UPDATE_PHASES: ReleasePhase[] = ["fetching", "deploying", "restarting", "done"];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function cleanError(raw: string): string {
  // Strip "Command failed (...), exitCode=N, stderr=" wrapper from internal errors
  const stderrMatch = raw.match(/stderr=(.+)$/s);
  if (stderrMatch) {
    const stderr = stderrMatch[1].trim();
    // Strip "fatal: " prefix git adds
    return stderr.replace(/^fatal:\s*/i, "");
  }
  return raw;
}

export function ReleaseManager(): JSX.Element {
  const [status, setStatus] = useState<ReleaseStatus | null>(null);
  const [info, setInfo] = useState<ReleaseInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [job, setJob] = useState<ReleaseJob | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [postRestartPolling, setPostRestartPolling] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const healthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/release/status");
      if (res.ok) setStatus((await res.json()) as ReleaseStatus);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [job?.log]);

  const startHealthPoll = useCallback((expectedTag: string | null) => {
    setPostRestartPolling(true);
    if (healthPollRef.current) clearInterval(healthPollRef.current);

    healthPollRef.current = setInterval(async () => {
      if (document.hidden) return; // skip polls while hidden
      recordReleaseManagerPollFire();
      try {
        const res = await fetch("/api/v1/release/status");
        if (res.ok) {
          const data = (await res.json()) as ReleaseStatus;
          if (data.tag && data.tag === expectedTag) {
            clearInterval(healthPollRef.current!);
            healthPollRef.current = null;
            setPostRestartPolling(false);
            setStatus(data);
            setJob((prev) => prev ? { ...prev, phase: "done", tag: data.tag } : prev);
            // App is confirmed running on new version — reload to pick up new UI
            setTimeout(() => window.location.reload(), 1500);
          }
        }
      } catch { /* server still down */ }
    }, 2000);
  }, []);

  const connectStream = useCallback(() => {
    eventSourceRef.current?.close();
    const es = new EventSource("/api/v1/release/stream");
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      const event = JSON.parse(e.data as string) as ReleaseStreamEvent;
      if (event.type === "snapshot") {
        setJob(event.job);
        return;
      }
      setJob((prev) => {
        if (!prev) return prev;
        if (event.type === "log") return { ...prev, log: [...prev.log, event.line] };
        if (event.type === "log.rewind") {
          return { ...prev, log: prev.log.slice(0, -event.count) };
        }
        if (event.type === "log.replace") {
          const updated = [...prev.log];
          if (updated.length > 0) {
            updated[updated.length - 1] = event.line;
          } else {
            updated.push(event.line);
          }
          return { ...prev, log: updated };
        }
        if (event.type === "phase") return { ...prev, phase: event.phase, error: event.error ?? prev.error };
        if (event.type === "runUrl") return { ...prev, runUrl: event.url };
        if (event.type === "tag") return { ...prev, tag: event.tag };
        return prev;
      });
    };

    es.onerror = () => {
      setJob((prev) => {
        if (prev?.phase === "restarting" || prev?.phase === "deploying") {
          startHealthPoll(prev.tag);
          return { ...prev, phase: "restarting" };
        }
        return prev;
      });
      es.close();
      eventSourceRef.current = null;
    };
  }, [startHealthPoll]);

  // On mount, connect to SSE so we pick up any in-progress or recently finished job
  useEffect(() => {
    connectStream();
    return () => {
      eventSourceRef.current?.close();
      if (healthPollRef.current) clearInterval(healthPollRef.current);
    };
  }, [connectStream]);

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
    setReleaseError(null);
    const res = await fetch("/api/v1/release/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag })
    });
    if (!res.ok) {
      const err = (await res.json()) as { error?: string };
      setReleaseError(cleanError(err.error ?? "Failed to start update"));
      return;
    }
    setJob({ jobType: "update", versionType: null, phase: "fetching", startedAt: new Date().toISOString(), log: [], runUrl: null, tag, error: null });
    connectStream();
  };

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

  const isActive = job !== null && !["done", "failed"].includes(job.phase) && !postRestartPolling;
  const isDone = job?.phase === "done" || (!postRestartPolling && job?.phase === "restarting" && status?.tag === job?.tag);
  const isFailed = job?.phase === "failed";
  const isRestarting = job?.phase === "restarting" || postRestartPolling;
  const showLog = job !== null;

  const phasesOrder = job?.jobType === "update" ? UPDATE_PHASES : CREATE_PHASES;
  const phaseIndex = job ? phasesOrder.indexOf(job.phase) : -1;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* Left column — controls */}
      <div className="flex md:w-[360px] shrink-0 flex-col gap-6 overflow-y-auto border-b md:border-b-0 md:border-r border-border p-4 md:p-6">

        {/* Current version */}
        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">Deployed version</div>
          {status ? (
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-xl font-bold text-foreground">{status.tag ?? "unknown"}</span>
              {status.deployedAt ? (
                <span className="text-xs text-muted-foreground">{formatDate(status.deployedAt)}</span>
              ) : null}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">Loading…</span>
          )}
        </div>

        {/* Check for updates / info — hidden while an operation is active */}
        {!isActive && !isDone && (
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
                Fetching…
              </div>
            )}

            {infoError && (
              <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {infoError}
              </div>
            )}

            {info && (
              <>
                {/* Update section — always visible */}
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

                    {releaseError && (
                      <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                        {releaseError}
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

                {/* Create release section — admin only */}
                {info.isAdmin && (
                  <div className="flex flex-col gap-4 border-t border-border pt-4">
                    <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Create release</div>

                    {info.refMissing ? (
                      <div className="rounded border border-status-waiting/30 bg-status-waiting/10 px-3 py-2 text-sm text-status-waiting">
                        Deployed version <span className="font-mono">{info.currentTag ?? "unknown"}</span> not found in origin — commit count unavailable.
                      </div>
                    ) : info.unreleasedCount === 0 ? (
                      <div className="text-xs text-muted-foreground">No unreleased commits on main</div>
                    ) : (
                      <div>
                        <div className="mb-2 text-xs text-muted-foreground">
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

                    {(info.refMissing || info.unreleasedCount > 0) && (
                      <>
                        {releaseError && (
                          <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                            {releaseError}
                          </div>
                        )}

                        <div className="flex flex-col gap-2">
                          <div className="mb-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">Release type</div>
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
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Phase progress — shown when a release/update is running or finished */}
        {job && (
          <div className="flex flex-col gap-4">
            <div>
              <div className="mb-3 text-[10px] uppercase tracking-widest text-muted-foreground">Progress</div>
              <div className="flex flex-col gap-2">
                {phasesOrder.filter((p) => p !== "done").map((phase, i) => {
                  const current = phaseIndex === i;
                  const done = phaseIndex > i || job.phase === "done";
                  return (
                    <div key={phase} className="flex items-center gap-3">
                      <div className={cn(
                        "h-2 w-2 rounded-full shrink-0",
                        done && "bg-status-working",
                        current && !isFailed && "animate-pulse bg-status-waiting",
                        current && isFailed && "bg-destructive",
                        !done && !current && "bg-muted"
                      )} />
                      <span className={cn(
                        "text-sm",
                        done && "text-muted-foreground",
                        current && !isFailed && "text-foreground font-medium",
                        current && isFailed && "text-destructive font-medium",
                        !done && !current && "text-muted-foreground/50"
                      )}>
                        {PHASE_LABELS[phase]}
                      </span>
                      {current && isRestarting && phase === "restarting" && (
                        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

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
              <div className="flex items-center gap-2 rounded border border-green-500/30 bg-green-500/10 px-3 py-2.5 text-sm text-green-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>
                  {job.jobType === "update" ? "Updated to" : "Deployed"}{" "}
                  <span className="font-mono font-semibold">{job.tag ?? status?.tag}</span>
                </span>
              </div>
            )}

            {isFailed && (
              <div className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{job.error ? cleanError(job.error) : "Operation failed"}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right column — log */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-2">
        {showLog ? (
          <div
            ref={logRef}
            className="min-h-0 flex-1 overflow-y-auto bg-black/60 p-4 font-mono text-[12px] leading-relaxed text-green-300"
          >
            {job!.log
              .filter((line) => line.trim() !== "DISPATCH_RESTARTING")
              .map((line, i) => (
                <div key={i}>{line || "\u00A0"}</div>
              ))}
            {isRestarting && !job?.log.length && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Waiting for Dispatch to restart…
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground/40">
            Log output will appear here
          </div>
        )}
      </div>
    </div>
  );
}
