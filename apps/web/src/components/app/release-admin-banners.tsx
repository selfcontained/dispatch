import { CheckCircle2, XCircle } from "lucide-react";
import { cleanError } from "@/components/app/release-utils";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import type { ReleaseJob } from "@/hooks/use-release-stream";

type ReleaseJobBannersProps = {
  job: ReleaseJob;
  releaseInFlight: boolean;
  isFailed: boolean;
  isDone: boolean;
  watchedRelease: boolean;
  onShowProgress: () => void;
  onDismiss: () => void;
};

/**
 * In-flight / failed / finished banners for a release-create job. The page
 * stays usable behind them — each banner just links into the progress view.
 */
export function ReleaseJobBanners({
  job,
  releaseInFlight,
  isFailed,
  isDone,
  watchedRelease,
  onShowProgress,
  onDismiss,
}: ReleaseJobBannersProps): JSX.Element {
  return (
    <>
      {releaseInFlight && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2.5 text-sm text-blue-300">
          <ActivityBars size={14} />
          <span>
            Releasing{" "}
            <span className="font-semibold capitalize">{job.versionType}</span>
            {job.tag && (
              <>
                {" "}
                <span className="font-mono">{job.tag}</span>
              </>
            )}{" "}
            — {job.phase}
          </span>
          <Button
            size="sm"
            variant="ghost-primary"
            className="ml-auto shrink-0"
            onClick={onShowProgress}
          >
            View progress
          </Button>
        </div>
      )}
      {isFailed && (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <XCircle className="h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate">
            Release failed
            {job.error ? `: ${cleanError(job.error)}` : ""}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button size="sm" variant="ghost-primary" onClick={onShowProgress}>
              Details
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {isDone && watchedRelease && (
        <div className="flex items-center gap-3 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2.5 text-sm text-green-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>
            Released <span className="font-mono font-semibold">{job.tag}</span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto shrink-0"
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        </div>
      )}
    </>
  );
}
