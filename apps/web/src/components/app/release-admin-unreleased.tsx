import { RefreshCw } from "lucide-react";
import { cleanError, formatAgo } from "@/components/app/release-utils";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import type { ReleaseInfo, ReleaseProgress } from "@/hooks/use-release-stream";
import { cn } from "@/lib/utils";

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
            onClick={onRefresh}
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
              Couldn't refresh <span className="font-mono">origin/main</span> —
              unreleased commit info is unavailable, not necessarily zero.
              <div className="mt-1 break-words font-mono text-xs opacity-80">
                {cleanError(info.unreleasedFetchError)}
              </div>
            </div>
          ) : info.refMissing ? (
            <div className="rounded-lg border border-status-waiting/30 bg-status-waiting/10 px-3 py-2 text-sm text-status-waiting">
              Deployed version{" "}
              <span className="font-mono">{info.currentTag ?? "unknown"}</span>{" "}
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
  );
}
