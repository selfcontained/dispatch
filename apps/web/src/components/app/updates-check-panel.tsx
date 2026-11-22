import { ArrowDownToLine, CheckCircle2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReleaseInfo, ReleaseProgress } from "@/hooks/use-release-stream";
import type { ReleaseInfoSnapshot } from "@/hooks/use-cached-release-info";
import { cn } from "@/lib/utils";
import { formatShortDateTime } from "@/lib/format";
import { formatInlineProgress, progressPercent } from "./release-utils";
import { Alert } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

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
          onClick={onCheckForUpdates}
          disabled={infoLoading}
          className="self-start text-muted-foreground hover:text-foreground"
        >
          Check for updates
        </Button>
        {(infoLoading || lastCheckMessage) && (
          <div className="flex min-w-0 items-center gap-2 text-body-md">
            {infoLoading && <Spinner className="text-muted-foreground" />}
            {!infoLoading && lastCheckMessage === "Up to date" && (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
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
          <div className="h-1.5 overflow-hidden rounded-full bg-fill-hover">
            <div
              className="h-full rounded-full bg-info transition-[width] duration-200"
              style={{ width: `${progressPercent(infoProgress)}%` }}
            />
          </div>
        </div>
      )}

      {infoError && (
        <Alert title="Couldn’t check for updates." error={infoError} />
      )}

      {displayInfo && (
        <>
          {displayInfo.updateAvailable && displayInfo.latestTag ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <ArrowDownToLine className="h-4 w-4 text-info" />
                <span className="text-body-md text-foreground">
                  <span className="font-mono font-semibold">
                    {displayInfo.latestTag}
                  </span>{" "}
                  available
                </span>
                {displayInfo.latestRelease?.publishedAt && (
                  <span className="text-body-sm text-muted-foreground">
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
                  className="inline-flex items-center gap-1.5 self-start text-body-sm text-info hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  View release on GitHub
                </a>
              )}

              {updateError && (
                <Alert title="Couldn’t start the update." error={updateError} />
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
