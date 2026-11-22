import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { SwitchToggle } from "@/components/app/jobs-form-fields";
import {
  LoopSetup,
  continuationMaxIterations,
  normalizeLoopItems,
  type ContinuationDraft,
} from "@/components/app/jobs-continuation-fields";
import { type UpdateJobConfig, type Job } from "@/hooks/use-jobs";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { SettingRow } from "@/components/ui/setting-row";
import { Textarea } from "@/components/ui/textarea";

export function PromptTab({
  job,
  onUpdateJob,
  isUpdating,
}: {
  job: Job;
  onUpdateJob: (job: UpdateJobConfig) => Promise<void>;
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
  const [saveError, setSaveError] = useState<unknown>();
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
    setSaveError(undefined);
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
      <Card className="p-4">
        <Field
          id={`prompt-${job.id}`}
          label="Task prompt"
          hint="What each run should work on."
        >
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe what the agent should do..."
            className="h-64 min-h-48 shrink-0 font-mono"
          />
        </Field>
        <SettingRow
          className="mt-3"
          label="Self improve after each run"
          description="Let the agent update this job's saved prompt when it finds a durable improvement."
        >
          <SwitchToggle
            checked={selfImprove}
            onCheckedChange={setSelfImprove}
            ariaLabel="Self improve after each run"
          />
        </SettingRow>
        <div className="mt-4 border-t border-border-subtle pt-4">
          <LoopSetup
            draft={continuation}
            onChange={setContinuation}
            idPrefix={`prompt-loop-${job.id}`}
          />
        </div>
        {saveError ? (
          <Alert
            title="Couldn’t save the instructions."
            error={saveError}
            className="mt-4"
          />
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-3">
          {saved ? (
            <span role="status" className="text-body-sm text-muted-foreground">
              Instructions saved.
            </span>
          ) : null}
          <Button
            variant="primary"
            pending={isUpdating}
            disabled={!loopValid}
            onClick={() => {
              setSaveError(undefined);
              setSaved(false);
              void onUpdateJob({
                jobId: job.id,
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
                  setSaveError(error);
                });
            }}
          >
            Save instructions
          </Button>
        </div>
      </Card>
    </div>
  );
}
