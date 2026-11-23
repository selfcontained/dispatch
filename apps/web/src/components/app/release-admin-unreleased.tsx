import { RefreshCw } from "lucide-react";
import { cleanError, formatAgo } from "@/components/app/release-utils";
import { IconButton } from "@/components/ui/icon-button";
import type { ReleaseInfo, ReleaseProgress } from "@/hooks/use-release-stream";
import { cn } from "@/lib/utils";
import { LoadError } from "@/components/ui/async-boundary";
import { SettingsGroup } from "@/components/app/settings-layout";
import { Alert } from "@/components/ui/alert";
import { Panel } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

type UnreleasedChangesProps = {
  info: ReleaseInfo | null;
  infoLoading: boolean;
  infoError: string | null;
  infoProgress: ReleaseProgress | null;
  lastCheckedAt: number | null;
  now: number;
  onRefresh: () => void;
};

/** The "Unreleased changes" section: commit count, commit list, and errors. */
export function UnreleasedChanges({
  info,
  infoLoading,
  infoError,
  infoProgress,
  lastCheckedAt,
  now,
  onRefresh,
}: UnreleasedChangesProps): JSX.Element {
  return (
    <SettingsGroup
      title="Unreleased changes"
      actions={
        <div className="flex items-center gap-2">
          {lastCheckedAt !== null && !infoLoading && (
            <span className="text-label-xs text-muted-foreground">
              Checked {formatAgo(lastCheckedAt, now)}
            </span>
          )}
          <IconButton
            tooltip="Refresh"
            label="Refresh unreleased changes"
            onClick={onRefresh}
            disabled={infoLoading}
          >
            <RefreshCw className={cn(infoLoading && "animate-spin")} />
          </IconButton>
        </div>
      }
    >
      {infoLoading && (
        <div className="flex items-center gap-2 text-body-sm text-muted-foreground">
          <Spinner />
          {infoProgress?.label ?? "Loading unreleased changes…"}
          {infoProgress?.detail && (
            <span className="text-faint">{infoProgress.detail}</span>
          )}
        </div>
      )}

      {infoError && (
        <LoadError
          thing="unreleased changes"
          error={infoError}
          retrying={infoLoading}
          onRetry={onRefresh}
        />
      )}

      {info && !infoLoading && (
        <>
          {info.unreleasedFetchError ? (
            <Alert
              tone="warning"
              title="Couldn’t refresh origin/main."
              error={cleanError(info.unreleasedFetchError)}
            >
              Unreleased commit info is unavailable, not necessarily zero.
            </Alert>
          ) : info.refMissing ? (
            <Alert tone="warning" title="Commit count unavailable.">
              Deployed version{" "}
              <span className="font-mono">{info.currentTag ?? "unknown"}</span>{" "}
              not found in origin.
            </Alert>
          ) : info.unreleasedCount === 0 ? (
            <div className="text-body-md text-muted-foreground">
              No unreleased commits on main
            </div>
          ) : (
            <div>
              <div className="mb-2 text-body-md text-muted-foreground">
                {info.unreleasedCount} unreleased{" "}
                {info.unreleasedCount === 1 ? "commit" : "commits"} on{" "}
                <span className="font-mono">main</span>
              </div>
              <Panel className="flex flex-col gap-0.5">
                {info.commits.map((c) => (
                  <div key={c.sha} className="flex gap-2 py-0.5 text-body-sm">
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {c.sha}
                    </span>
                    <span className="min-w-0 break-words text-foreground">
                      {c.subject}
                    </span>
                  </div>
                ))}
                {info.unreleasedCount > info.commits.length && (
                  <div className="mt-1 text-body-sm text-muted-foreground">
                    +{info.unreleasedCount - info.commits.length} more
                  </div>
                )}
              </Panel>
            </div>
          )}
        </>
      )}
    </SettingsGroup>
  );
}
