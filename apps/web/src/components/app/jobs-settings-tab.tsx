import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  JobAgentTypeField,
  JobFullAccessOption,
  JobKeepAgentOption,
  JobScheduleField,
  JobWorktreeOption,
  SwitchToggle,
  WebhookUrl,
} from "@/components/app/jobs-form-fields";
import { AgentModelSelect } from "@/components/app/agent-model-select";
import { api } from "@/lib/api";
import {
  cronError,
  errorMessage,
  minutesFromMs,
  msFromMinutes,
} from "@/components/app/jobs-helpers";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type AddJobConfig, type Job } from "@/hooks/use-jobs";
import { type AgentType, type CliAgentType } from "@/lib/agent-types";

export function SettingsTab({
  job,
  enabledAgentTypes,
  onUpdateJob,
  onRemoveJob,
  isUpdating,
  isRemoving,
}: {
  job: Job;
  enabledAgentTypes: AgentType[];
  onUpdateJob: (job: AddJobConfig) => Promise<void>;
  onRemoveJob: (job: Job) => Promise<void>;
  isUpdating: boolean;
  isRemoving: boolean;
}) {
  const [displayName, setDisplayName] = useState(job.name);
  const [schedule, setSchedule] = useState(job.schedule ?? "");
  const [timeoutMinutes, setTimeoutMinutes] = useState(
    minutesFromMs(job.timeoutMs)
  );
  const [needsInputTimeoutMinutes, setNeedsInputTimeoutMinutes] = useState(
    minutesFromMs(job.needsInputTimeoutMs)
  );
  const [agentType, setAgentType] = useState<CliAgentType>(job.agentType);
  const [model, setModel] = useState<string | null>(job.model);
  const { data: modelCatalog, isLoading: modelCatalogLoading } = useQuery<{
    models: Partial<Record<CliAgentType, Array<{ id: string; label: string }>>>;
  }>({
    queryKey: ["agent-models"],
    queryFn: () => api("/api/v1/agent-models"),
  });
  const modelOptions = modelCatalog?.models[agentType] ?? [];
  const [fullAccess, setFullAccess] = useState(job.fullAccess);
  const [useWorktree, setUseWorktree] = useState(job.useWorktree);
  const [baseBranch, setBaseBranch] = useState(job.baseBranch ?? "main");
  const [branchName, setBranchName] = useState(job.branchName ?? "");
  const [keepAgent, setKeepAgent] = useState(!job.autoArchive);
  const [callable, setCallable] = useState(job.callable);
  const [singleton, setSingleton] = useState(job.singleton);
  const [webhookEnabled, setWebhookEnabled] = useState(job.webhookEnabled);
  const [enabled, setEnabled] = useState(job.enabled);
  const [isUpdatingEnabled, setIsUpdatingEnabled] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [enabledError, setEnabledError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const effectiveEnabled = schedule.trim() ? enabled : false;
  const hasSavedSchedule = Boolean(job.schedule?.trim());
  const scheduleError = cronError(schedule, effectiveEnabled);
  const canSave =
    !!displayName.trim() &&
    !scheduleError &&
    !!msFromMinutes(timeoutMinutes) &&
    !!msFromMinutes(needsInputTimeoutMinutes);

  // Reset form state only when switching to a different job — not on every
  // refetch of the same job.  SSE-driven invalidations change volatile fields
  // (updatedAt, lastRun*, nextRun) which would otherwise clobber unsaved edits.
  useEffect(() => {
    setDisplayName(job.name);
    setSchedule(job.schedule ?? "");
    setTimeoutMinutes(minutesFromMs(job.timeoutMs));
    setNeedsInputTimeoutMinutes(minutesFromMs(job.needsInputTimeoutMs));
    setAgentType(job.agentType);
    setModel(job.model);
    setFullAccess(job.fullAccess);
    setUseWorktree(job.useWorktree);
    setBaseBranch(job.baseBranch ?? "main");
    setBranchName(job.branchName ?? "");
    setKeepAgent(!job.autoArchive);
    setCallable(job.callable);
    setSingleton(job.singleton);
    setWebhookEnabled(job.webhookEnabled);
    setEnabled(job.enabled);
    setSaveError(null);
    setEnabledError(null);
    setRemoveError(null);
    setRemoveDialogOpen(false);
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  return (
    <div className="mt-4 grid gap-4">
      <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm">
        <span>
          <span className="block font-medium text-foreground">Enabled</span>
          <span className="block text-xs text-muted-foreground">
            {hasSavedSchedule
              ? "Allow this job to run on its schedule."
              : "Save a schedule before enabling this job."}
          </span>
        </span>
        <SwitchToggle
          checked={enabled}
          onCheckedChange={(nextEnabled) => {
            if (!hasSavedSchedule || isUpdatingEnabled) return;
            setEnabled(nextEnabled);
            setEnabledError(null);
            setIsUpdatingEnabled(true);
            void onUpdateJob({
              name: job.name,
              directory: job.directory,
              enabled: nextEnabled,
            })
              .catch((error) => {
                setEnabled(job.enabled);
                setEnabledError(errorMessage(error));
              })
              .finally(() => {
                setIsUpdatingEnabled(false);
              });
          }}
          ariaLabel="Enable schedule"
          disabled={!hasSavedSchedule || isUpdatingEnabled}
        />
      </label>
      {enabledError ? (
        <div className="rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">
          {enabledError}
        </div>
      ) : null}
      <div className="rounded-md border border-white/[0.12] bg-white/[0.04] p-4">
        <div className="text-sm font-medium">Job configuration</div>
        <p className="mt-1 text-xs text-muted-foreground">
          These values are used when the schedule or Run button starts this job.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="space-y-1 md:col-span-2">
            <label
              className="text-sm text-muted-foreground"
              htmlFor={`settings-name-${job.id}`}
            >
              Name
            </label>
            <Input
              id={`settings-name-${job.id}`}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>
          <JobScheduleField
            id={`settings-schedule-${job.id}`}
            schedule={schedule}
            scheduleError={scheduleError}
            enabled={enabled}
            enabledHelperText="Run this job on its saved schedule."
            showEnabled={false}
            onScheduleChange={setSchedule}
            onEnabledChange={setEnabled}
          />
          <JobAgentTypeField
            value={agentType}
            agentTypes={enabledAgentTypes}
            onChange={(nextAgentType) => {
              setAgentType(nextAgentType);
              setModel(null);
            }}
          />
          {modelOptions.length > 0 || modelCatalogLoading ? (
            <AgentModelSelect
              value={model}
              options={modelOptions}
              onChange={setModel}
              loading={modelCatalogLoading}
            />
          ) : null}
          <div className="space-y-1">
            <label
              className="text-sm text-muted-foreground"
              htmlFor={`settings-timeout-${job.id}`}
            >
              Run timeout, minutes
            </label>
            <Input
              id={`settings-timeout-${job.id}`}
              value={timeoutMinutes}
              onChange={(event) => setTimeoutMinutes(event.target.value)}
              inputMode="numeric"
            />
          </div>
          <div className="space-y-1">
            <label
              className="text-sm text-muted-foreground"
              htmlFor={`settings-needs-input-${job.id}`}
            >
              Wait for input, minutes
            </label>
            <Input
              id={`settings-needs-input-${job.id}`}
              value={needsInputTimeoutMinutes}
              onChange={(event) =>
                setNeedsInputTimeoutMinutes(event.target.value)
              }
              inputMode="numeric"
            />
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <JobWorktreeOption
            checked={useWorktree}
            cwd={job.directory}
            baseBranch={baseBranch}
            branchName={branchName}
            onCheckedChange={setUseWorktree}
            onBaseBranchChange={setBaseBranch}
            onBranchNameChange={setBranchName}
            testIdPrefix={`job-settings-${job.id}`}
          />
          <JobFullAccessOption
            checked={fullAccess}
            onCheckedChange={setFullAccess}
          />
          <JobKeepAgentOption
            checked={keepAgent}
            onCheckedChange={setKeepAgent}
          />
          <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm">
            <span>
              <span className="block font-medium text-foreground">
                Show in command palette
              </span>
              <span className="block text-xs text-muted-foreground">
                Launch this job from the {"⌘"}K palette.
              </span>
            </span>
            <SwitchToggle
              checked={callable}
              onCheckedChange={setCallable}
              ariaLabel="Show in command palette"
            />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm">
            <span>
              <span className="block font-medium text-foreground">
                Single instance
              </span>
              <span className="block text-xs text-muted-foreground">
                Only allow one active run at a time.
              </span>
            </span>
            <SwitchToggle
              checked={singleton}
              onCheckedChange={setSingleton}
              ariaLabel="Single instance"
            />
          </label>
          <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm">
            <label className="flex items-center justify-between gap-3">
              <span>
                <span className="block font-medium text-foreground">
                  Webhook trigger
                </span>
                <span className="block text-xs text-muted-foreground">
                  Trigger this job via an HTTP POST to a secret URL.
                </span>
              </span>
              <SwitchToggle
                checked={webhookEnabled}
                onCheckedChange={setWebhookEnabled}
                ariaLabel="Webhook trigger"
              />
            </label>
            {webhookEnabled && job.webhookSecret ? (
              <WebhookUrl secret={job.webhookSecret} />
            ) : webhookEnabled && !job.webhookSecret ? (
              <div className="mt-2 text-xs text-muted-foreground">
                Save to generate a webhook URL.
              </div>
            ) : null}
          </div>
        </div>
        {saveError ? (
          <div className="mt-4 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">
            {saveError}
          </div>
        ) : null}
        {saved ? (
          <div className="mt-4 rounded-md border border-status-done/40 bg-status-done/10 p-3 text-sm text-status-done">
            Settings saved.
          </div>
        ) : null}
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            disabled={!canSave || isUpdating}
            onClick={() => {
              setSaveError(null);
              setSaved(false);
              void onUpdateJob({
                name: job.name,
                directory: job.directory,
                displayName,
                schedule: schedule.trim() || null,
                timeoutMs: msFromMinutes(timeoutMinutes),
                needsInputTimeoutMs: msFromMinutes(needsInputTimeoutMinutes),
                agentType,
                model,
                useWorktree,
                baseBranch: useWorktree ? baseBranch : null,
                branchName: useWorktree ? branchName : null,
                fullAccess,
                autoArchive: !keepAgent,
                callable,
                singleton,
                webhookEnabled,
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
            Save
          </Button>
        </div>
      </div>
      <div className="rounded-md border border-status-blocked/30 bg-status-blocked/5 p-4">
        <div className="text-sm font-medium text-status-blocked">
          Remove job
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Remove this saved job, schedule, and run history from this Dispatch
          instance.
        </p>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            variant="destructive"
            size="sm"
            disabled={isRemoving}
            onClick={() => {
              setRemoveError(null);
              setRemoveDialogOpen(true);
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Remove
          </Button>
        </div>
        {removeError ? (
          <div className="mt-3 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">
            {removeError}
          </div>
        ) : null}
      </div>
      <RemoveJobDialog
        open={removeDialogOpen}
        job={job}
        isRemoving={isRemoving}
        onOpenChange={setRemoveDialogOpen}
        onConfirm={() => {
          setRemoveError(null);
          void onRemoveJob(job)
            .then(() => setRemoveDialogOpen(false))
            .catch((error) => setRemoveError(errorMessage(error)));
        }}
      />
    </div>
  );
}

function RemoveJobDialog({
  open,
  job,
  isRemoving,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  job: Job;
  isRemoving: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-md" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-white/[0.2] bg-[hsl(var(--card))] backdrop-blur-2xl p-5 shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)] outline-none">
          <DialogPrimitive.Title className="text-base font-semibold">
            Remove job?
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 text-sm text-muted-foreground">
            Remove{" "}
            <span className="font-medium text-foreground">{job.name}</span> from
            this Dispatch instance? This removes its saved schedule and run
            history.
          </DialogPrimitive.Description>
          <div className="mt-5 flex justify-end gap-2">
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" disabled={isRemoving}>
                Cancel
              </Button>
            </DialogPrimitive.Close>
            <Button
              variant="destructive"
              disabled={isRemoving}
              onClick={onConfirm}
            >
              {isRemoving ? (
                <ActivityBars size={16} className="mr-2" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Remove
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
