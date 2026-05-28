import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Trash2,
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
import {
  AssistedUpdateGate,
  AssistedUpdateProgress,
  PendingMigrationsGate,
} from "@/components/app/assisted-update-card";
import { OperationTakeover } from "@/components/app/release-operation-takeover";
import { UpdateActions } from "@/components/app/release-update-actions";
import type {
  ReleaseChannel,
  UseReleaseStreamResult,
} from "@/hooks/use-release-stream";
import { useReleaseUpdates } from "@/hooks/use-release-updates";
import { cn } from "@/lib/utils";
import {
  UPDATE_PHASES,
  formatDate,
  formatInlineProgress,
  progressPercent,
  describeForceTriggers,
} from "./release-utils";

type UpdatesSectionProps = {
  stream: UseReleaseStreamResult;
};

export function UpdatesSection({ stream }: UpdatesSectionProps): JSX.Element {
  const {
    status,
    infoProgress,
    postRestartPolling,

    versionInfo,
    notesExpanded,
    setNotesExpanded,
    channel,
    channelSaving,
    autoUpdateMode,
    autoUpdateSaving,
    infoLoading,
    infoError,
    updateError,
    assistedUpdateLaunching,
    forceConfirmOpen,
    setForceConfirmOpen,
    lastCheckMessage,

    displayInfo,

    updateJob,
    assistedJob,
    isDone,
    isFailed,
    isRestarting,
    showTakeover,

    handleAutoUpdateModeChange,
    handleChannelChange,
    handleCheckForUpdates,
    handleUpdate,
    handleAssistedUpdate,
    handleReload,
    handleClearCacheAndReload,
    handleDismiss,
    handleAssistedDismiss,
  } = useReleaseUpdates(stream);

  if (assistedJob) {
    return (
      <AssistedUpdateProgress
        job={assistedJob}
        onDismiss={handleAssistedDismiss}
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
        onDismiss={handleDismiss}
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
