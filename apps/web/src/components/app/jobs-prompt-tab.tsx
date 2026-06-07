import { useEffect, useState } from "react";

import { errorMessage } from "@/components/app/jobs-helpers";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import { type AddJobConfig, type Job } from "@/hooks/use-jobs";

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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setPrompt(job.prompt ?? "");
    setSaveError(null);
    setSaved(false);
  }, [job]);

  return (
    <div className="mt-4 flex h-full min-h-full flex-col">
      <div className="flex h-full min-h-full flex-1 flex-col rounded-md border border-white/[0.12] bg-white/[0.04] p-4">
        <div className="space-y-1">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor={`prompt-${job.id}`}
          >
            Prompt
          </label>
          <p className="text-xs text-muted-foreground">
            The instructions the agent will follow when this job runs.
          </p>
        </div>
        <textarea
          id={`prompt-${job.id}`}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe what the agent should do..."
          className="mt-2 h-[max(16rem,calc(100dvh-21rem))] min-h-64 shrink-0 w-full rounded-md border border-white/[0.12] bg-white/[0.04] backdrop-blur-md shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {saveError ? (
          <div className="mt-4 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">
            {saveError}
          </div>
        ) : null}
        {saved ? (
          <div className="mt-4 rounded-md border border-status-done/40 bg-status-done/10 p-3 text-sm text-status-done">
            Prompt saved.
          </div>
        ) : null}
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            disabled={isUpdating}
            onClick={() => {
              setSaveError(null);
              setSaved(false);
              void onUpdateJob({
                name: job.name,
                directory: job.directory,
                prompt: prompt.trim() || null,
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
            Save prompt
          </Button>
        </div>
      </div>
    </div>
  );
}
