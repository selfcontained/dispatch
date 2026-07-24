import { Activity, AlarmClock, Clock } from "lucide-react";

import { useJobsContext } from "@/components/app/jobs-context";
import { statusClasses, statusIcon } from "@/components/app/jobs-helpers";
import { shortPath } from "@/lib/format";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Job list content for the unified sidebar. */
export function JobListContent({
  onItemSelect,
  hideHeader,
}: {
  onItemSelect?: () => void;
  hideHeader?: boolean;
}): JSX.Element {
  const {
    jobs,
    isLoading,
    error,
    selectedJob,
    showOverview,
    actionErrorByJobId,
    selectJob,
    openAddJob,
    navigate,
  } = useJobsContext();

  return (
    <div data-testid="jobs-sidebar" className="flex min-h-0 flex-1 flex-col">
      {hideHeader ? (
        <div className="flex items-center justify-end px-3 py-2">
          <Button
            size="sm"
            variant="default"
            className="bg-muted/35 text-muted-foreground hover:bg-muted/65 hover:text-foreground"
            onClick={openAddJob}
            data-testid="add-job-button"
          >
            <AlarmClock className="mr-1 h-4 w-4" />
            Create
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex h-14 items-center border-b border-border px-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Jobs
          </h2>
          <div className="ml-auto flex items-center">
            <Button
              size="sm"
              variant="default"
              className="bg-muted/35 text-muted-foreground hover:bg-muted/65 hover:text-foreground"
              onClick={openAddJob}
              data-testid="add-job-button"
            >
              <AlarmClock className="mr-1 h-4 w-4" />
              Create
            </Button>
          </div>
        </div>
      )}

      <div
        data-testid="jobs-sidebar-scroll"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {error ? (
          <div className="m-3 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">
            {error instanceof Error ? error.message : "Failed to load jobs."}
          </div>
        ) : isLoading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <ActivityBars size={16} /> Loading jobs...
          </div>
        ) : jobs.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            <div className="rounded-md border border-dashed border-border p-4">
              <div className="font-medium text-foreground">
                No jobs added yet.
              </div>
              <div className="mt-1 text-xs">
                Added jobs will appear here — run them on a schedule or on
                demand.
              </div>
            </div>
          </div>
        ) : (
          <div>
            <button
              className={cn(
                "flex w-full items-center gap-2 border-b border-r-4 border-border border-r-transparent px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/40",
                showOverview && "border-r-primary bg-muted/60"
              )}
              onClick={() => {
                navigate("/automations/jobs/overview");
                onItemSelect?.();
              }}
            >
              <Activity className="h-3.5 w-3.5" />
              <span>Overview</span>
            </button>
            {jobs.map((job) => {
              const actionError = actionErrorByJobId[job.id];
              return (
                <div
                  key={job.id}
                  data-testid={`job-row-${job.id}`}
                  className={cn(
                    "w-full cursor-pointer border-b border-r-4 border-border border-r-transparent px-3 py-2 text-left transition-colors hover:bg-muted/40",
                    selectedJob?.id === job.id &&
                      "md:border-r-primary md:bg-muted/60"
                  )}
                  onClick={() => {
                    selectJob(job);
                    onItemSelect?.();
                  }}
                >
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold leading-5">
                        {job.name}
                      </div>
                      <div
                        className="truncate font-mono text-[11px] text-muted-foreground"
                        title={job.directory}
                      >
                        {shortPath(job.directory)}
                      </div>
                    </div>
                    <Badge className={statusClasses(job.lastRunStatus)}>
                      <span className="mr-1 hidden sm:inline-flex">
                        {statusIcon(job.lastRunStatus)}
                      </span>
                      {job.lastRunStatus ?? "new"}
                    </Badge>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">
                      {job.schedule ? `Cron: ${job.schedule}` : "On demand"}
                    </span>
                    {job.schedule ? (
                      <>
                        <span className="shrink-0 text-muted-foreground/70">
                          •
                        </span>
                        <span className="shrink-0">
                          {job.enabled ? "enabled" : "disabled"}
                        </span>
                      </>
                    ) : null}
                    {!job.autoArchive ? (
                      <>
                        <span className="shrink-0 text-muted-foreground/70">
                          •
                        </span>
                        <span className="shrink-0">keeps agent</span>
                      </>
                    ) : null}
                    {job.callable ? (
                      <>
                        <span className="shrink-0 text-muted-foreground/70">
                          •
                        </span>
                        <span className="shrink-0">callable</span>
                      </>
                    ) : null}
                  </div>
                  {actionError ? (
                    <div className="mt-2 rounded border border-status-blocked/30 bg-status-blocked/10 px-2 py-1 text-xs text-status-blocked">
                      {actionError}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
