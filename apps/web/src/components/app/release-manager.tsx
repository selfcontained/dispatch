import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowDownToLine,
  Bot,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  type ReleaseProgress,
  type UseReleaseStreamResult,
} from "@/hooks/use-release-stream";
import { api } from "@/lib/api";
import { agentRoute } from "@/lib/agent-routes";
import {
  useCachedReleaseInfo,
  type ReleaseInfoSnapshot,
} from "@/hooks/use-cached-release-info";
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

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

function formatProgressLabel(job: ReleaseJob): string | null {
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

function formatInlineProgress(progress: ReleaseProgress | null): string | null {
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

function progressPercent(progress: ReleaseProgress | null): number | null {
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

function describeForceTriggers(
  info: ReleaseInfo | ReleaseInfoSnapshot
): string {
  const migrationCount = info.pendingMigrations?.length ?? 0;
  // Migrations are the concrete signal — when present the user already
  // sees them spelled out in the gate card, so the dialog references the
  // count directly. mode=required is meta (release author flagged it);
  // when migrations are also present, the migration count is the more
  // useful framing, so we don't double-mention.
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

type UpdatesSectionProps = {
  stream: UseReleaseStreamResult;
};

export function UpdatesSection({ stream }: UpdatesSectionProps): JSX.Element {
  const navigate = useNavigate();
  const {
    status,
    job,
    infoProgress,
    postRestartPolling,
    streamClientId,
    connectStream,
    setJob,
  } = stream;

  const [versionInfo, setVersionInfo] = useState<AppVersionInfo | null>(null);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [channel, setChannel] = useState<ReleaseChannel>("stable");
  const [channelSaving, setChannelSaving] = useState(false);
  const [autoUpdateMode, setAutoUpdateMode] = useState<"off" | "check">(
    "check"
  );
  const [autoUpdateSaving, setAutoUpdateSaving] = useState(false);
  const [info, setInfo] = useState<ReleaseInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [assistedUpdateLaunching, setAssistedUpdateLaunching] = useState(false);
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false);
  const [lastCheckMessage, setLastCheckMessage] = useState<string | null>(null);
  const reloadingRef = useRef(false);

  const cachedInfoQuery = useCachedReleaseInfo();
  const cachedSnapshot = cachedInfoQuery.data?.snapshot ?? null;

  // Prefer the live ReleaseInfo from a manual check (which carries admin
  // enrichment) when present; otherwise fall back to the cached snapshot
  // from the server's auto-check. Both shapes share every field this
  // component renders — admin-only fields live on ReleaseInfo and aren't
  // read here, so the union type is intentionally narrow on purpose: any
  // future admin-only addition will require an explicit type widening.
  const displayInfo: ReleaseInfo | ReleaseInfoSnapshot | null =
    info ?? cachedSnapshot;

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
    void api<{ mode: "off" | "check" }>("/api/v1/release/auto-update-mode")
      .then((data) => {
        if (!cancelled) setAutoUpdateMode(data.mode);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAutoUpdateModeChange = useCallback(
    async (next: "off" | "check") => {
      setAutoUpdateMode(next);
      setAutoUpdateSaving(true);
      try {
        await api("/api/v1/release/auto-update-mode", {
          method: "POST",
          body: JSON.stringify({ mode: next }),
        });
      } catch {
        setAutoUpdateMode((prev) => (prev === "off" ? "check" : "off"));
      } finally {
        setAutoUpdateSaving(false);
      }
    },
    []
  );

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
    setLastCheckMessage(null);
    try {
      const res = await fetch("/api/v1/release/info", {
        headers: {
          "X-Dispatch-Release-Client-Id": streamClientId,
        },
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        setInfoError(cleanError(err.error ?? "Failed to check for updates"));
        return;
      }
      const nextInfo = (await res.json()) as ReleaseInfo;
      setInfo(nextInfo);
      if (!nextInfo.updateAvailable) {
        setLastCheckMessage("Up to date");
      }
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

  useEffect(() => {
    if (lastCheckMessage === null) return;
    const timeout = window.setTimeout(() => {
      setLastCheckMessage(null);
    }, 3000);
    return () => window.clearTimeout(timeout);
  }, [lastCheckMessage]);

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
      progress: {
        step: "starting-update",
        label: "Starting update",
        detail: "Preparing the update job and connecting to progress events.",
      },
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

      {/* Automatic updates */}
      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Automatic updates
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          When on, Dispatch periodically checks for new releases and notifies
          you. Updates never install automatically.
        </p>
        <div
          className={cn(
            "inline-block min-w-[14rem]",
            autoUpdateSaving && "opacity-50 pointer-events-none"
          )}
        >
          <Select
            value={autoUpdateMode}
            onValueChange={(value) =>
              void handleAutoUpdateModeChange(value as "off" | "check")
            }
          >
            <SelectTrigger
              data-testid="auto-update-mode-select"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off" data-testid="auto-update-mode-off">
                Off
              </SelectItem>
              <SelectItem value="check" data-testid="auto-update-mode-check">
                Automatically check
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Check for updates */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            size="sm"
            variant="default"
            onClick={() => void handleCheckForUpdates()}
            disabled={infoLoading}
            className="self-start text-muted-foreground hover:text-foreground"
          >
            Check for updates
          </Button>
          {(infoLoading || lastCheckMessage) && (
            <div className="flex min-w-0 items-center gap-2 text-sm">
              {infoLoading && (
                <ActivityBars
                  size={14}
                  className="shrink-0 text-muted-foreground"
                />
              )}
              {!infoLoading && lastCheckMessage === "Up to date" && (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />
              )}
              <span
                className={cn(
                  "truncate",
                  infoLoading ? "text-muted-foreground" : "text-foreground"
                )}
              >
                {infoLoading
                  ? (formatInlineProgress(infoProgress) ??
                    "Checking for updates")
                  : lastCheckMessage}
              </span>
            </div>
          )}
        </div>

        {infoLoading && progressPercent(infoProgress) !== null && (
          <div className="max-w-[40rem]">
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
              <div
                className="h-full rounded-full bg-blue-400 transition-[width] duration-200"
                style={{ width: `${progressPercent(infoProgress)}%` }}
              />
            </div>
          </div>
        )}

        {infoError && (
          <div className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {infoError}
          </div>
        )}

        {displayInfo && (
          <>
            {displayInfo.updateAvailable && displayInfo.latestTag ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <ArrowDownToLine className="h-4 w-4 text-blue-400" />
                  <span className="text-sm text-foreground">
                    <span className="font-mono font-semibold">
                      {displayInfo.latestTag}
                    </span>{" "}
                    available
                  </span>
                  {displayInfo.latestRelease?.publishedAt && (
                    <span className="text-xs text-muted-foreground">
                      · {formatDate(displayInfo.latestRelease.publishedAt)}
                    </span>
                  )}
                </div>

                {displayInfo.latestRelease?.url && (
                  <a
                    href={displayInfo.latestRelease.url}
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

                {displayInfo.migrationsError && (
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
                        {displayInfo.migrationsError}
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
                {displayInfo.pendingMigrations &&
                  displayInfo.pendingMigrations.length > 0 && (
                    <PendingMigrationsGate
                      tag={displayInfo.latestTag}
                      pendingMigrations={displayInfo.pendingMigrations}
                    />
                  )}
                {displayInfo.assisted &&
                  displayInfo.assisted.mode !== "normal" && (
                    <AssistedUpdateGate
                      tag={displayInfo.latestTag}
                      metadata={displayInfo.assisted}
                      required={displayInfo.assistedRequired === true}
                    />
                  )}

                {(() => {
                  const assistedPreferred =
                    displayInfo.assistedRequired === true ||
                    (displayInfo.pendingMigrations?.length ?? 0) > 0 ||
                    displayInfo.assisted?.mode === "recommended";
                  return (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 self-start">
                      <UpdateActions
                        tag={displayInfo.latestTag}
                        assistedPreferred={assistedPreferred}
                        forceRequired={
                          displayInfo.assistedRequired === true ||
                          (displayInfo.pendingMigrations?.length ?? 0) > 0
                        }
                        assistedLaunching={assistedUpdateLaunching}
                        onStandardUpdate={() =>
                          void handleUpdate(displayInfo.latestTag!)
                        }
                        onAssistedUpdate={() =>
                          void handleAssistedUpdate(displayInfo.latestTag!)
                        }
                        onForceStandardUpdate={() => setForceConfirmOpen(true)}
                      />
                      <span className="text-xs text-muted-foreground">
                        or {assistedPreferred ? "standard" : "agent-assisted"}{" "}
                        update
                      </span>
                    </div>
                  );
                })()}
              </div>
            ) : null}
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

      {displayInfo?.updateAvailable && displayInfo.latestTag && (
        <Dialog open={forceConfirmOpen} onOpenChange={setForceConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Skip the agent-assisted update?</DialogTitle>
            </DialogHeader>

            <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-sm text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <span>
                <span className="font-mono text-amber-100">
                  {displayInfo.latestTag}
                </span>{" "}
                {describeForceTriggers(displayInfo)}. This may leave your
                install in a non-working state.
              </span>
            </div>

            <div className="mt-1 flex flex-wrap gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  setForceConfirmOpen(false);
                  void handleUpdate(displayInfo.latestTag!, { force: true });
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
    : "Agent-assisted update";
  const assistedDescription = "Agent runs and validates each step";

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
              className="flex items-center gap-2.5 text-foreground"
              data-testid="standard-update-menu-item"
            >
              <ArrowDownToLine className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
            className="flex items-start gap-2.5 text-foreground"
            data-testid="assisted-update-menu-item"
          >
            <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="flex flex-col">
              <span>{assistedLabel}</span>
              <span className="text-xs text-muted-foreground">
                {assistedDescription}
              </span>
            </div>
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
        {job.progress && (
          <div className="rounded-lg border border-white/[0.12] bg-white/[0.04] p-3">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Current step
            </div>
            <div className="mt-2 text-sm font-medium text-foreground">
              {job.progress.label}
            </div>
            {job.progress.detail && (
              <div className="mt-1 text-xs text-muted-foreground">
                {job.progress.detail}
              </div>
            )}
            {formatProgressLabel(job) && (
              <div className="mt-2 text-xs font-medium text-blue-300">
                {formatProgressLabel(job)}
              </div>
            )}
            {job.progress.totalBytes &&
              job.progress.bytesReceived !== null &&
              job.progress.bytesReceived !== undefined &&
              job.progress.totalBytes > 0 && (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                  <div
                    className="h-full rounded-full bg-blue-400 transition-[width] duration-200"
                    style={{
                      width: `${Math.min(
                        100,
                        (job.progress.bytesReceived / job.progress.totalBytes) *
                          100
                      )}%`,
                    }}
                  />
                </div>
              )}
          </div>
        )}

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
