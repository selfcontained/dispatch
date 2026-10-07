import { ArrowDownToLine, CheckCircle2, ExternalLink } from "lucide-react";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import type { ReleaseInfo, ReleaseProgress } from "@/hooks/use-release-stream";
import type { ReleaseInfoSnapshot } from "@/hooks/use-cached-release-info";
import { cn } from "@/lib/utils";
import { formatShortDateTime } from "@/lib/format";
import { formatInlineProgress, progressPercent } from "./release-utils";

type UpdatesCheckPanelProps = {
  infoLoading: boolean;
  infoProgress: ReleaseProgress | null;
  infoError: string | null;
  lastCheckMessage: string | null;
  displayInfo: ReleaseInfo | ReleaseInfoSnapshot | null;
  updateError: string | null;
  onCheckForUpdates: () => void;
  onUpdate: (tag: string) => void;
};

/**
 * The check-for-updates control and everything it reveals: inline progress,
 * errors, and — when a newer release exists — the update button.
 */
export function UpdatesCheckPanel({
  infoLoading,
  infoProgress,
  infoError,
  lastCheckMessage,
  displayInfo,
  updateError,
  onCheckForUpdates,
  onUpdate,
}: UpdatesCheckPanelProps): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          size="sm"
          variant="default"
          onClick={onCheckForUpdates}
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
                ? (formatInlineProgress(infoProgress) ?? "Checking for updates")
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
                    ·{" "}
                    {formatShortDateTime(displayInfo.latestRelease.publishedAt)}
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

              <Button
                variant="primary"
                className="self-start"
                onClick={() => onUpdate(displayInfo.latestTag!)}
                data-testid="update-button"
              >
                Update to {displayInfo.latestTag}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
