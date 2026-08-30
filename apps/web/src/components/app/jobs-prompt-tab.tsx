import { useEffect, useState } from "react";

import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import { SwitchToggle } from "@/components/app/jobs-form-fields";
import {
  LoopSetup,
  continuationMaxIterations,
  normalizeLoopItems,
  type ContinuationDraft,
} from "@/components/app/jobs-continuation-fields";
import { type AddJobConfig, type Job } from "@/hooks/use-jobs";
import { errorMessage } from "@/lib/errors";

export function PromptTab({
  job,
  onUpdateJob,
  isUpdating,
}: {
  job: Job;
  onUpdateJob: (job: AddJobConfig) => Promise<void>;
  isUpdating: boolean;
}) {
  const [prompt, setPrompt] = useState(job.prompt ?? "");
  const [selfImprove, setSelfImprove] = useState(job.selfImprove);
  const [continuation, setContinuation] = useState<ContinuationDraft>({
    enabled: Boolean(job.continuationEnabled),
    maxIterations: job.maxIterations === null ? "" : String(job.maxIterations),
    completionCriteria: job.completionCriteria ?? [],
    recoveryInstructions: job.recoveryInstructions ?? "",
  });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setPrompt(job.prompt ?? "");
    setSelfImprove(job.selfImprove);
    setContinuation({
      enabled: Boolean(job.continuationEnabled),
      maxIterations:
        job.maxIterations === null ? "" : String(job.maxIterations),
      completionCriteria: job.completionCriteria ?? [],
      recoveryInstructions: job.recoveryInstructions ?? "",
    });
    setSaveError(null);
    setSaved(false);
    // Reset only for an actual job selection change. SSE refetches update
    // volatile continuation fields while edits may still be in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  const loopValid =
    !continuation.enabled ||
    !continuation.maxIterations.trim() ||
    Boolean(continuationMaxIterations(continuation.maxIterations));

  return (
    <div className="mt-4">
      <div className="rounded-md border border-white/[0.12] bg-white/[0.04] p-4">
        <div className="space-y-1">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor={`prompt-${job.id}`}
          >
            Task prompt
          </label>
          <p className="text-xs text-muted-foreground">
            What each run should work on.
          </p>
        </div>
        <textarea
          id={`prompt-${job.id}`}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe what the agent should do..."
          className="mt-2 h-64 min-h-48 shrink-0 w-full rounded-md border border-white/[0.12] bg-white/[0.04] backdrop-blur-md shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <label className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm">
          <span>
            <span className="block font-medium text-foreground">
              Self improve after each run
            </span>
            <span className="block text-xs text-muted-foreground">
              Let the agent update this job's saved prompt when it finds a
              durable improvement.
            </span>
          </span>
          <SwitchToggle
            checked={selfImprove}
            onCheckedChange={setSelfImprove}
            ariaLabel="Self improve after each run"
          />
        </label>
        <div className="mt-4 border-t border-border/70 pt-4">
          <LoopSetup
            draft={continuation}
            onChange={setContinuation}
            idPrefix={`prompt-loop-${job.id}`}
          />
        </div>
        {saveError ? (
          <div className="mt-4 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">
            {saveError}
          </div>
        ) : null}
        {saved ? (
          <div className="mt-4 rounded-md border border-status-done/40 bg-status-done/10 p-3 text-sm text-status-done">
            Instructions saved.
          </div>
        ) : null}
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            disabled={!loopValid || isUpdating}
            onClick={() => {
              setSaveError(null);
              setSaved(false);
              void onUpdateJob({
                name: job.name,
                directory: job.directory,
                prompt: prompt.trim() || null,
                selfImprove,
                continuationEnabled: continuation.enabled,
                maxIterations: continuation.enabled
                  ? continuationMaxIterations(continuation.maxIterations)
                  : null,
                completionCriteria: continuation.enabled
                  ? normalizeLoopItems(continuation.completionCriteria)
                  : null,
                recoveryInstructions: continuation.enabled
                  ? continuation.recoveryInstructions.trim() || null
                  : null,
                ...(continuation.enabled ? { autoArchive: true } : {}),
              })
                .then(() => {
                  setSaved(true);
                })
                .catch((error) => {
                  setSaveError(errorMessage(error));
                });
            }}
          >
            {isUpdating ? <ActivityBars size={16} className="mr-2" /> : null}
            Save instructions
          </Button>
        </div>
      </div>
    </div>
  );
}
