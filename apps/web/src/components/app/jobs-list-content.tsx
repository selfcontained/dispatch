import { SidebarTop } from "./sidebar-top";
import { useProjectScope } from "@/hooks/use-projects";
import { Activity, AlarmClock, Clock } from "lucide-react";

import { useJobsContext } from "@/components/app/jobs-context";
import { JobStatusBadge } from "@/components/app/jobs-helpers";
import { shortPath } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";
import { cn } from "@/lib/utils";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";

/** Job list content for the unified sidebar. */
export function JobListContent({
  onItemSelect,
}: {
  onItemSelect?: () => void;
}): JSX.Element {
  const {
    jobs: allJobs,
    jobsQuery,
    selectedJob,
    showOverview,
    actionErrorByJobId,
    selectJob,
    openAddJob,
    navigate,
  } = useJobsContext();

  const { projectId } = useProjectScope();
  const jobs = projectId
    ? allJobs.filter((j) => j.projectId === projectId)
    : allJobs;
  return (
    <div data-testid="jobs-sidebar" className="flex min-h-0 flex-1 flex-col">
      <SidebarTop
        action={
          <Button
            size="sm"
            variant="primary"
            onClick={openAddJob}
            data-testid="add-job-button"
          >
            <AlarmClock />
            New job
          </Button>
        }
      />

      <div
        data-testid="jobs-sidebar-scroll"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <AsyncBoundary
          query={jobsQuery}
          thing="jobs"
          className="m-3"
          isEmpty={() => jobs.length === 0}
          empty={
            <EmptyState
              title="No jobs added yet."
              description="Added jobs will appear here — run them on a schedule or on demand."
            />
          }
        >
          {() => (
            <div>
              <RowButton
                className={cn(
                  "rounded-none border-b border-r-4 border-border border-r-transparent px-3 py-3 text-body-md text-muted-foreground",
                  showOverview && "border-r-primary bg-surface-hover"
                )}
                onClick={() => {
                  navigate("/automations/jobs/overview");
                  onItemSelect?.();
                }}
              >
                <Activity className="size-icon-md" />
                <span>Overview</span>
              </RowButton>
              {jobs.map((job) => {
                const actionError = actionErrorByJobId[job.id];
                return (
                  <div
                    key={job.id}
                    data-testid={`job-row-${job.id}`}
                    className={cn(
                      "w-full cursor-pointer border-b border-r-4 border-border border-r-transparent px-3 py-2 text-left transition-colors hover:bg-surface-hover",
                      selectedJob?.id === job.id &&
                        "md:border-r-primary md:bg-surface-hover"
                    )}
                    onClick={() => {
                      selectJob(job);
                      onItemSelect?.();
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-body-md font-semibold leading-5">
                          {job.name}
                        </div>
                        <div
                          className="truncate font-mono text-label-sm text-muted-foreground"
                          title={job.directory}
                        >
                          {shortPath(job.directory)}
                        </div>
                      </div>
                      <JobStatusBadge status={job.lastRunStatus} empty="New" />
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-body-sm text-muted-foreground">
                      <Clock className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">
                        {job.schedule ? `Cron: ${job.schedule}` : "On demand"}
                      </span>
                      {job.schedule ? (
                        <>
                          <span className="shrink-0 text-faint">•</span>
                          <span className="shrink-0">
                            {job.enabled ? "enabled" : "disabled"}
                          </span>
                        </>
                      ) : null}
                      {job.continuationEnabled ? (
                        <>
                          <span className="shrink-0 text-faint">•</span>
                          <span className="shrink-0">
                            {job.continuationPending
                              ? "next run pending"
                              : job.lastRunIteration
                                ? `run ${job.lastRunIteration}`
                                : "loop"}
                          </span>
                        </>
                      ) : null}
                      {!job.autoArchive ? (
                        <>
                          <span className="shrink-0 text-faint">•</span>
                          <span className="shrink-0">keeps agent</span>
                        </>
                      ) : null}
                      {job.callable ? (
                        <>
                          <span className="shrink-0 text-faint">•</span>
                          <span className="shrink-0">callable</span>
                        </>
                      ) : null}
                    </div>
                    {actionError ? (
                      <Alert title={actionError} className="mt-2" />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </AsyncBoundary>
      </div>
    </div>
  );
}
