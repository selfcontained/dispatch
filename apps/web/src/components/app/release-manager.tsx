import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Markdown } from "@/components/ui/markdown";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OperationLog, PhaseProgress } from "@/components/app/release-shared";
import {
  AssistedUpdateGate,
  AssistedUpdateProgress,
  PendingMigrationsGate,
} from "@/components/app/assisted-update-card";
import {
  type ReleaseChannel,
  type ReleaseInfo,
  type ReleaseJob,
  type UseReleaseStreamResult,
} from "@/hooks/use-release-stream";
import { api } from "@/lib/api";
import { agentRoute } from "@/lib/agent-routes";
import { clearCachesAndReload, reloadApp } from "@/lib/pwa-update";
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
    minute: "2-digit",
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

function describeForceTriggers(info: ReleaseInfo): string {
  const migrationCount = info.pendingMigrations?.length ?? 0;
  const isRequired = info.assistedRequired === true && migrationCount === 0;
  const reasons: string[] = [];
  if (migrationCount > 0) {
    reasons.push(
      `ships ${migrationCount} install-update migration${
        migrationCount === 1 ? "" : "s"
      } that haven't been applied here yet`
    );
  }
  if (info.assistedRequired === true) {
    // Distinct phrasing depending on whether migrations are also pending —
    // when both apply, the operator should know they're overriding both
    // signals, not just one.
    reasons.push(
      isRequired
        ? "is marked assisted-update required"
        : "is also marked assisted-update required"
    );
  }
  if (reasons.length === 0) return "is gated by the assisted-update flow";
  if (reasons.length === 1) return reasons[0]!;
  return `${reasons[0]} and ${reasons[1]}`;
}

type UpdatesSectionProps = {
  stream: UseReleaseStreamResult;
};

export function UpdatesSection({ stream }: UpdatesSectionProps): JSX.Element {
  const navigate = useNavigate();
  const { status, job, postRestartPolling, connectStream, setJob } = stream;

  const [versionInfo, setVersionInfo] = useState<AppVersionInfo | null>(null);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [channel, setChannel] = useState<ReleaseChannel>("stable");
  const [channelSaving, setChannelSaving] = useState(false);
  const [info, setInfo] = useState<ReleaseInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [assistedUpdateLaunching, setAssistedUpdateLaunching] = useState(false);
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false);
  const reloadingRef = useRef(false);

  // Fetch version info + channel on mount
  useEffect(() => {
    let cancelled = false;
    void api<AppVersionInfo>("/api/v1/app/version")
      .then((data) => {
        if (!cancelled) setVersionInfo(data);
      })
      .catch(() => {});
    void api<{ channel: ReleaseChannel }>("/api/v1/release/channel")
      .then((data) => {
        if (!cancelled) setChannel(data.channel);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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
      setChannel((prev) => (prev === "stable" ? "latest" : "stable"));
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
      setInfoError(
        err instanceof Error
          ? cleanError(err.message)
          : "Failed to check for updates"
      );
    } finally {
      setInfoLoading(false);
    }
  };

  const handleUpdate = async (tag: string, options?: { force?: boolean }) => {
    setUpdateError(null);
    const res = await fetch("/api/v1/release/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag, force: options?.force === true }),
    });
    if (!res.ok) {
      const err = (await res.json()) as { error?: string };
      setUpdateError(cleanError(err.error ?? "Failed to start update"));
      return;
    }
    setJob({
      jobType: "update",
      versionType: null,
      phase: "fetching",
      startedAt: new Date().toISOString(),
      log: [],
      runUrl: null,
      tag,
      error: null,
    });
    connectStream();
  };

  const handleAssistedUpdate = useCallback(
    async (tag: string) => {
      setUpdateError(null);
      setAssistedUpdateLaunching(true);
      try {
        const payload = await api<{ agent: { id: string } }>(
          "/api/v1/release/assisted/launch",
          {
            method: "POST",
            body: JSON.stringify({ tag }),
          }
        );
        navigate(agentRoute(payload.agent.id));
      } catch (err) {
        setUpdateError(
          err instanceof Error
            ? cleanError(err.message)
            : "Failed to start assisted update"
        );
      } finally {
        setAssistedUpdateLaunching(false);
      }
    },
    [navigate]
  );

  const handleReload = useCallback(() => {
    if (reloadingRef.current) return;
    reloadingRef.current = true;
    void reloadApp();
  }, []);

  const handleClearCacheAndReload = useCallback(() => {
    if (reloadingRef.current) return;
    reloadingRef.current = true;
    void clearCachesAndReload();
  }, []);

  // Only show takeover for update jobs
  const updateJob = job?.jobType === "update" ? job : null;
  const assistedJob = job?.jobType === "update-assisted" ? job : null;
  const isDone =
    updateJob?.phase === "done" ||
    (!postRestartPolling &&
      updateJob?.phase === "restarting" &&
      status?.tag === updateJob?.tag);
  const isFailed = updateJob?.phase === "failed";
  const isRestarting =
    updateJob?.phase === "restarting" ||
    (updateJob !== null && postRestartPolling);
  // Only show takeover for active jobs, not stale done jobs from server memory
  const showTakeover = updateJob !== null && !isDone;

  if (assistedJob) {
    return (
      <AssistedUpdateProgress
        job={assistedJob}
        onDismiss={() => {
          void fetch("/api/v1/release/assisted/state", {
            method: "DELETE",
          }).catch(() => {});
          setJob(null);
          setInfo(null);
          setUpdateError(null);
        }}
      />
    );
  }

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
        onDismiss={() => {
          setJob(null);
          setInfo(null);
          setUpdateError(null);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      {/* Current version */}
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Current version
        </div>
        {status ? (
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xl font-bold text-foreground">
              {status.tag ?? "unknown"}
            </span>
            {status.deployedAt ? (
              <span className="text-xs text-muted-foreground">
                {formatDate(status.deployedAt)}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">Loading...</span>
        )}

        {versionInfo && (
          <div className="mt-3 grid gap-2 rounded-lg border border-white/[0.12] bg-white/[0.04] p-3 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Release tag</span>
              <span className="font-mono">
                {versionInfo.releaseTag ?? "unreleased"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Package version</span>
              <span className="font-mono">
                {versionInfo.version ?? "unknown"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Git SHA</span>
              <span className="font-mono">
                {versionInfo.gitSha ?? "unavailable"}
              </span>
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
            {notesExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
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
            <div className="mt-2 rounded-lg border border-white/[0.12] bg-white/[0.04] p-3">
              <div className="max-h-56 overflow-y-auto text-sm text-muted-foreground">
                <Markdown>{versionInfo.releaseNotes}</Markdown>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="border-t border-white/[0.12]" />

      {/* Release channel */}
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Release channel
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          Choose which releases this instance follows.
        </p>
        <div
          className={cn(
            "inline-flex",
            channelSaving && "opacity-50 pointer-events-none"
          )}
        >
          {(["stable", "latest"] as ReleaseChannel[]).map((ch) => (
            <Button
              key={ch}
              size="sm"
              variant={channel === ch ? "primary" : "default"}
              onClick={() => void handleChannelChange(ch)}
              className={cn(
                "capitalize",
                ch === "stable" && "rounded-r-none border-r-0",
                ch === "latest" && "rounded-l-none border-l border-white/[0.12]"
              )}
            >
              {ch}
            </Button>
          ))}
        </div>
      </div>

      {/* Check for updates */}
      <div className="flex flex-col gap-4">
        {!info && !infoLoading && (
          <Button
            size="sm"
            variant="default"
            onClick={() => void handleCheckForUpdates()}
            className="self-start text-muted-foreground hover:text-foreground"
          >
            Check for updates
          </Button>
        )}

        {infoLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ActivityBars size={14} />
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
                    <span className="font-mono font-semibold">
                      {info.latestTag}
                    </span>{" "}
                    available
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

                {info.migrationsError && (
                  <div
                    className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-sm text-amber-200"
                    data-testid="migration-eval-warning"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-medium text-amber-100">
                        Could not evaluate update migrations
                      </span>
                      <span className="max-h-24 overflow-y-auto break-all text-xs text-amber-200/80">
                        {info.migrationsError}
                      </span>
                      <span className="text-xs text-amber-200/60">
                        Standard update is still available — the assisted flow
                        is the safer choice if you&rsquo;re unsure.
                      </span>
                    </div>
                  </div>
                )}

                {/*
                  Informational gate cards — the action lives in the split
                  button below. Migration list shows when the release ships
                  unapplied install-update migrations; assisted-metadata card
                  shows when the release declares mode=required/recommended.
                */}
                {info.pendingMigrations &&
                  info.pendingMigrations.length > 0 && (
                    <PendingMigrationsGate
                      tag={info.latestTag}
                      pendingMigrations={info.pendingMigrations}
                    />
                  )}
                {info.assisted && info.assisted.mode !== "normal" && (
                  <AssistedUpdateGate
                    tag={info.latestTag}
                    metadata={info.assisted}
                    required={info.assistedRequired === true}
                  />
                )}

                <UpdateActions
                  tag={info.latestTag}
                  assistedPreferred={
                    info.assistedRequired === true ||
                    (info.pendingMigrations?.length ?? 0) > 0 ||
                    info.assisted?.mode === "recommended"
                  }
                  forceRequired={
                    info.assistedRequired === true ||
                    (info.pendingMigrations?.length ?? 0) > 0
                  }
                  assistedLaunching={assistedUpdateLaunching}
                  onStandardUpdate={() => void handleUpdate(info.latestTag!)}
                  onAssistedUpdate={() =>
                    void handleAssistedUpdate(info.latestTag!)
                  }
                  onForceStandardUpdate={() => setForceConfirmOpen(true)}
                />
                <p className="max-w-xl text-xs text-muted-foreground">
                  Assisted update launches a full-access agent on the production
                  checkout, redirects you into its terminal, and tells it to
                  recover service first if the restart goes sideways.
                </p>
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

      <div className="border-t border-white/[0.12]" />

      {/* Reload */}
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Reload
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          Reload the app to pick up the latest version.
        </p>
        <div className="inline-flex items-center">
          <Button
            size="sm"
            variant="default"
            onClick={handleReload}
            className="rounded-r-none border-r-0 text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            Reload
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="default"
                className="rounded-l-none border-l border-white/[0.12] px-1 text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
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

      {info?.updateAvailable && info.latestTag && (
        <Dialog open={forceConfirmOpen} onOpenChange={setForceConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Skip the assisted-update flow?</DialogTitle>
              <DialogDescription>
                This release <span className="font-mono">{info.latestTag}</span>{" "}
                {describeForceTriggers(info)}. The standard update skips the
                agent-driven steps — it just fetches the new artifact and
                restarts the service. Use it as a recovery path when the
                assisted flow can&rsquo;t run (for example if the AI provider is
                unreachable). Your install may end up in an unsupported state if
                the migration steps were actually needed.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  setForceConfirmOpen(false);
                  void handleUpdate(info.latestTag!, { force: true });
                }}
                data-testid="force-standard-update-confirm"
              >
                Run standard update anyway
              </Button>
              <Button
                variant="default"
                onClick={() => setForceConfirmOpen(false)}
              >
                Cancel
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

type UpdateActionsProps = {
  tag: string;
  /** True when the assisted flow should be the primary action — release ships
   *  pending migrations, declares mode=required, or declares mode=recommended. */
  assistedPreferred: boolean;
  /** True when the standard path requires a force-override confirmation —
   *  pending migrations or mode=required. mode=recommended does not require
   *  confirmation; the operator can still run standard one-click. */
  forceRequired: boolean;
  assistedLaunching: boolean;
  onStandardUpdate: () => void;
  onAssistedUpdate: () => void;
  /** Invoked when the user picks "Standard update" from the menu in a state
   *  that requires force-override confirmation. */
  onForceStandardUpdate: () => void;
};

function UpdateActions({
  tag,
  assistedPreferred,
  forceRequired,
  assistedLaunching,
  onStandardUpdate,
  onAssistedUpdate,
  onForceStandardUpdate,
}: UpdateActionsProps): JSX.Element {
  const standardLabel = `Update to ${tag}`;
  const assistedLabel = assistedLaunching
    ? "Launching agent..."
    : "Assisted update";

  // Trailing ellipsis follows the platform convention "selecting this opens
  // a dialog before committing." Used in the forceRequired branch where the
  // menu item triggers a confirmation, not the update itself.
  const standardMenuLabel = forceRequired ? `${standardLabel}…` : standardLabel;

  if (assistedPreferred) {
    return (
      <div className="inline-flex items-center self-start">
        <Button
          variant="primary"
          disabled={assistedLaunching}
          onClick={onAssistedUpdate}
          className="rounded-r-none border-r-0"
          data-testid="assisted-update-button"
        >
          {assistedLabel}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="primary"
              disabled={assistedLaunching}
              className="rounded-l-none border-l border-white/[0.18] px-1"
              aria-label="More update options"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() =>
                forceRequired ? onForceStandardUpdate() : onStandardUpdate()
              }
              data-testid="standard-update-menu-item"
            >
              <ArrowDownToLine className="mr-2 h-3.5 w-3.5" />
              {standardMenuLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center self-start">
      <Button
        variant="primary"
        disabled={assistedLaunching}
        onClick={onStandardUpdate}
        className="rounded-r-none border-r-0"
        data-testid="standard-update-button"
      >
        {standardLabel}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="primary"
            disabled={assistedLaunching}
            className="rounded-l-none border-l border-white/[0.18] px-1"
            aria-label="More update options"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={assistedLaunching}
            onClick={onAssistedUpdate}
            data-testid="assisted-update-menu-item"
          >
            {assistedLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
      <div className="flex md:w-[360px] shrink-0 flex-col gap-6 overflow-y-auto border-b md:border-b-0 md:border-r border-white/[0.12] p-4 md:p-6">
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
                <span className="font-mono font-semibold">
                  {job.tag ?? status?.tag}
                </span>
              </span>
            </div>
            <Button
              variant="default"
              onClick={onDismiss}
              className="self-start text-muted-foreground hover:text-foreground"
            >
              Done
            </Button>
          </div>
        )}

        {isFailed && (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {job.error ? cleanError(job.error) : "Operation failed"}
              </span>
            </div>
            <Button
              variant="default"
              onClick={onDismiss}
              className="self-start text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </Button>
          </div>
        )}
      </div>

      {/* Right column — log */}
      <OperationLog
        logRef={logRef}
        job={job}
        isRestarting={isRestarting}
        postRestartPolling={postRestartPolling}
      />
    </div>
  );
}
