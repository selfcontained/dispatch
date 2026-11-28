import { AgentConfigRow } from "./agent-config-row";
import type { Effort } from "@dispatch/shared";
import { AgentEffortSelect } from "./agent-effort-select";
import { useProjects } from "@/hooks/use-projects";
import { ProjectLocation } from "@/components/app/project-location";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LaunchTargetError } from "./launch-target-error";
import { RunnerPicker } from "./runner-picker";
import { RunnerProjectPicker } from "./runner-project-picker";
import { useJobTarget } from "./use-job-target";

import {
  JobAgentTypeField,
  JobFullAccessOption,
  JobKeepAgentOption,
  JobScheduleField,
  JobWorktreeOption,
  SwitchToggle,
  WebhookUrl,
} from "@/components/app/jobs-form-fields";
import { AgentPersonaSelect } from "@/components/app/agent-persona-select";
import { PathInput } from "@/components/app/path-input";
import { useCwdHistory } from "@/components/app/create-agent-dialog-utils";
import { AgentModelSelect } from "@/components/app/agent-model-select";
import {
  cronError,
  minutesFromMs,
  msFromMinutes,
} from "@/components/app/jobs-helpers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type UpdateJobConfig, type Job } from "@/hooks/use-jobs";
import {
  type AgentType,
  type CliAgentType,
  isCliAgentType,
} from "@/lib/agent-types";
import { Alert } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { SettingRow } from "@/components/ui/setting-row";

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
  onUpdateJob: (job: UpdateJobConfig) => Promise<void>;
  onRemoveJob: (job: Job) => Promise<void>;
  isUpdating: boolean;
  isRemoving: boolean;
}) {
  const { data: projects = [], isSuccess: projectsLoaded } = useProjects();
  const [locationEdit, setLocationEdit] = useState<{
    id: string;
    projectId: string | null;
    directory: string;
  } | null>(null);
  const hasLocationEdit =
    locationEdit?.id === job.id &&
    (locationEdit.projectId === null ||
      !projectsLoaded ||
      projects.some((p) => p.id === locationEdit.projectId));
  const location = hasLocationEdit
    ? locationEdit!
    : { projectId: job.projectId ?? null, directory: job.directory };
  const projectId = location.projectId;
  const directory =
    projects.find((p) => p.id === projectId)?.repoRoot ?? location.directory;
  const membershipChanged =
    hasLocationEdit && projectId !== (job.projectId ?? null);
  const {
    history: cwdHistory,
    removableHistory: removableCwdHistory,
    historyMetadata: cwdHistoryMetadata,
    remove: removeCwdHistory,
    add: addCwdHistory,
  } = useCwdHistory();
  const [displayName, setDisplayName] = useState(job.name);
  const [schedule, setSchedule] = useState(job.schedule ?? "");
  const [timeoutMinutes, setTimeoutMinutes] = useState(
    minutesFromMs(job.timeoutMs)
  );
  const [needsInputTimeoutMinutes, setNeedsInputTimeoutMinutes] = useState(
    minutesFromMs(job.needsInputTimeoutMs)
  );
  const [agentType, setAgentType] = useState<CliAgentType>(job.agentType);
  const [persona, setPersona] = useState<string | null>(job.persona ?? null);
  const [effort, setEffort] = useState<Effort | null>(job.effort ?? null);
  const [model, setModel] = useState<string | null>(job.model);
  const onTargetAgentTypes = useCallback(
    (types: AgentType[]) => {
      const next = types.find(isCliAgentType);
      if (types.includes(agentType) || !next) return;
      setAgentType(next);
      setModel(null);
      setEffort(null);
    },
    [agentType]
  );
  const target = useJobTarget({
    templateId: job.templateId,
    directory,
    projectId,
    agentType,
    model,
    onAgentTypes: onTargetAgentTypes,
  });
  const {
    options: modelOptions,
    savedOption,
    loading: modelCatalogLoading,
    normalizeModel,
  } = target.models;
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
  const [saveError, setSaveError] = useState<unknown>();
  const [enabledError, setEnabledError] = useState<unknown>();
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const effectiveEnabled =
    schedule.trim() || job.continuationEnabled ? enabled : false;
  const hasSavedSchedule = Boolean(job.schedule?.trim());
  const scheduleError = cronError(
    schedule,
    effectiveEnabled,
    Boolean(job.continuationEnabled)
  );
  const canSave =
    !!displayName.trim() &&
    target.launch.selectionReady &&
    (target.byProject
      ? target.projects.some((p) => p.id === projectId)
      : !!directory.trim()) &&
    !scheduleError &&
    !!msFromMinutes(timeoutMinutes) &&
    !!msFromMinutes(needsInputTimeoutMinutes);

  // Reset form state only when switching to a different job — not on every
  // refetch of the same job.  SSE-driven invalidations change volatile fields
  // (updatedAt, lastRun*, nextRun) which would otherwise clobber unsaved edits.
  const { reset: resetTarget } = target.launch;
  useEffect(() => {
    resetTarget();
    setDisplayName(job.name);
    setLocationEdit(null);
    setSchedule(job.schedule ?? "");
    setTimeoutMinutes(minutesFromMs(job.timeoutMs));
    setNeedsInputTimeoutMinutes(minutesFromMs(job.needsInputTimeoutMs));
    setAgentType(job.agentType);
    setModel(job.model);
    setEffort(job.effort ?? null);
    setPersona(job.persona ?? null);
    setFullAccess(job.fullAccess);
    setUseWorktree(job.useWorktree);
    setBaseBranch(job.baseBranch ?? "main");
    setBranchName(job.branchName ?? "");
    setKeepAgent(!job.autoArchive);
    setCallable(job.callable);
    setSingleton(job.singleton);
    setWebhookEnabled(job.webhookEnabled);
    setEnabled(job.enabled);
    setSaveError(undefined);
    setEnabledError(undefined);
    setRemoveDialogOpen(false);
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id]);

  return (
    <div className="mt-4 grid gap-4">
      <SettingRow
        label="Enabled"
        description={
          hasSavedSchedule
            ? "Allow manual and scheduled starts."
            : job.continuationEnabled
              ? "Allow this loop to start."
              : "Save a schedule before enabling this job."
        }
        disabled={!hasSavedSchedule && !job.continuationEnabled}
      >
        <SwitchToggle
          checked={enabled}
          onCheckedChange={(nextEnabled) => {
            if (
              (!hasSavedSchedule && !job.continuationEnabled) ||
              isUpdatingEnabled
            )
              return;
            setEnabled(nextEnabled);
            setEnabledError(undefined);
            setIsUpdatingEnabled(true);
            void onUpdateJob({
              jobId: job.id,
              enabled: nextEnabled,
            })
              .catch((error) => {
                setEnabled(job.enabled);
                setEnabledError(error);
              })
              .finally(() => {
                setIsUpdatingEnabled(false);
              });
          }}
          ariaLabel={job.continuationEnabled ? "Enable job" : "Enable schedule"}
          disabled={
            (!hasSavedSchedule && !job.continuationEnabled) || isUpdatingEnabled
          }
        />
      </SettingRow>
      {enabledError ? (
        <Alert
          title="Couldn’t change whether the job is enabled."
          error={enabledError}
        />
      ) : null}
      <Card className="p-4">
        <h2 className="text-heading-sm">Job configuration</h2>
        <p className="mt-1 text-body-sm text-muted-foreground">
          These values are used when the schedule or Run button starts this job.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="space-y-3 empty:hidden md:col-span-2">
            <RunnerPicker
              targets={target.launch.list.data ?? []}
              value={target.launch.key}
              onChange={(key) => {
                setModel(null);
                setEffort(null);
                setPersona(null);
                setLocationEdit({ id: job.id, projectId: null, directory: "" });
                setBaseBranch(
                  target.launch.list.data?.find((t) => t.key === key)
                    ?.defaultBaseBranch ?? "main"
                );
                target.launch.choose(key);
              }}
            />
            <LaunchTargetError queries={[target.launch.list, target.data]} />
          </div>
          <Field
            id={`settings-name-${job.id}`}
            label="Name"
            className="md:col-span-2"
          >
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
          {target.byProject ? (
            <div className="md:col-span-2">
              <RunnerProjectPicker
                projects={target.projects}
                projectId={projectId}
                loading={target.launch.list.isLoading}
                error={Boolean(target.launch.target?.location.error)}
                onProject={(id) =>
                  setLocationEdit({ id: job.id, projectId: id, directory: "" })
                }
              />
            </div>
          ) : (
            <div className="space-y-1 md:col-span-2">
              <label
                className="text-body-sm font-medium"
                htmlFor={`settings-directory-${job.id}`}
              >
                Working directory
              </label>
              <ProjectLocation
                projectId={projectId}
                onChange={(project) =>
                  setLocationEdit({
                    id: job.id,
                    projectId: project?.id ?? null,
                    directory: project?.repoRoot ?? directory,
                  })
                }
              >
                <PathInput
                  id={`settings-directory-${job.id}`}
                  value={directory}
                  onChange={(directory) =>
                    setLocationEdit({ id: job.id, projectId: null, directory })
                  }
                  placeholder="/path/to/repo"
                  history={cwdHistory}
                  removableHistory={removableCwdHistory}
                  historyMetadata={cwdHistoryMetadata}
                  onRemoveHistory={removeCwdHistory}
                />
              </ProjectLocation>
            </div>
          )}
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
          <AgentPersonaSelect
            cwd={directory}
            endpoint={
              target.byProject
                ? projectId
                  ? (target.data.data?.personasUrl ?? "")
                  : ""
                : undefined
            }
            value={persona}
            onChange={setPersona}
          />
          <AgentConfigRow
            className="md:col-span-2"
            showModel={modelOptions.length > 0 || modelCatalogLoading}
          >
            <JobAgentTypeField
              value={agentType}
              agentTypes={
                (target.byProject && target.data.info?.agentTypes) ||
                enabledAgentTypes
              }
              onChange={(nextAgentType) => {
                setAgentType(nextAgentType);
                setModel(null);
                setEffort(null);
              }}
            />
            {modelOptions.length > 0 || modelCatalogLoading ? (
              <AgentModelSelect
                value={model}
                options={modelOptions}
                savedOption={savedOption(model)}
                onChange={(value) => {
                  setModel(value);
                  setEffort(null);
                }}
                loading={modelCatalogLoading}
              />
            ) : null}
            <AgentEffortSelect
              model={model}
              workload={target.byProject}
              workloadChoices={target.data.effort}
              value={effort}
              onChange={setEffort}
              agentType={agentType}
              id={`settings-job-effort-${job.id}`}
            />
          </AgentConfigRow>
          <Field id={`settings-timeout-${job.id}`} label="Run timeout, minutes">
            <Input
              value={timeoutMinutes}
              onChange={(event) => setTimeoutMinutes(event.target.value)}
              inputMode="numeric"
            />
          </Field>
          <Field
            id={`settings-needs-input-${job.id}`}
            label="Wait for input, minutes"
          >
            <Input
              value={needsInputTimeoutMinutes}
              onChange={(event) =>
                setNeedsInputTimeoutMinutes(event.target.value)
              }
              inputMode="numeric"
            />
          </Field>
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <JobWorktreeOption
            checked={useWorktree}
            cwd={directory}
            baseBranch={baseBranch}
            branchName={branchName}
            onCheckedChange={setUseWorktree}
            onBaseBranchChange={setBaseBranch}
            onBranchNameChange={setBranchName}
            branchesUrl={target.byProject ? target.data.branchesUrl : undefined}
            defaultBaseBranch={
              target.byProject ? target.data.defaultBaseBranch : undefined
            }
            testIdPrefix={`job-settings-${job.id}`}
          />
          {agentType !== "opencode" && (
            <JobFullAccessOption
              checked={fullAccess}
              onCheckedChange={setFullAccess}
            />
          )}
          <JobKeepAgentOption
            checked={keepAgent}
            onCheckedChange={setKeepAgent}
            disabled={Boolean(job.continuationEnabled)}
            helperText={
              job.continuationEnabled
                ? "Unavailable while the loop is on."
                : undefined
            }
          />
          <SettingRow
            label="Show in command palette"
            description={<>Launch this job from the {"⌘"}K palette.</>}
          >
            <SwitchToggle
              checked={callable}
              onCheckedChange={setCallable}
              ariaLabel="Show in command palette"
            />
          </SettingRow>
          <SettingRow
            label="Single instance"
            description="Only allow one active run at a time."
          >
            <SwitchToggle
              checked={singleton}
              onCheckedChange={setSingleton}
              ariaLabel="Single instance"
            />
          </SettingRow>
          <SettingRow
            label="Webhook trigger"
            description="Trigger this job via an HTTP POST to a secret URL."
            details={
              !webhookEnabled ? null : job.webhookSecret ? (
                <WebhookUrl secret={job.webhookSecret} />
              ) : (
                <p className="text-body-sm text-muted-foreground">
                  Save to generate a webhook URL.
                </p>
              )
            }
          >
            <SwitchToggle
              checked={webhookEnabled}
              onCheckedChange={setWebhookEnabled}
              ariaLabel="Webhook trigger"
            />
          </SettingRow>
        </div>
        {saveError ? (
          <Alert
            title="Couldn’t save the job."
            error={saveError}
            className="mt-4"
          />
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-3">
          {saved ? (
            <span role="status" className="text-body-sm text-muted-foreground">
              Settings saved.
            </span>
          ) : null}
          <Button
            variant="primary"
            pending={isUpdating}
            disabled={!canSave}
            onClick={() => {
              setSaveError(undefined);
              setSaved(false);
              const submittedLocation = locationEdit;
              void onUpdateJob({
                jobId: job.id,
                name: displayName.trim(),
                ...(target.byProject ? {} : { directory: directory.trim() }),
                ...target.launch.fields,
                ...(membershipChanged ? { projectId } : {}),
                schedule: schedule.trim() || null,
                timeoutMs: msFromMinutes(timeoutMinutes),
                needsInputTimeoutMs: msFromMinutes(needsInputTimeoutMinutes),
                agentType,
                model: normalizeModel(model),
                effort,
                persona,
                useWorktree,
                baseBranch: useWorktree ? baseBranch : null,
                branchName: useWorktree ? branchName : null,
                fullAccess: agentType === "opencode" || fullAccess,
                autoArchive: job.continuationEnabled ? true : !keepAgent,
                callable,
                singleton,
                webhookEnabled,
              })
                .then(() => {
                  setLocationEdit((current) =>
                    current === submittedLocation ? null : current
                  );
                  if (!target.byProject) addCwdHistory(directory.trim());
                  setSaved(true);
                })
                .catch((error) => {
                  setSaveError(error);
                });
            }}
          >
            Save
          </Button>
        </div>
      </Card>
      <Card variant="panel" tone="danger" className="p-4">
        <h2 className="text-heading-sm text-danger">Remove job</h2>
        <p className="mt-1 text-body-sm text-muted-foreground">
          Remove this saved job, schedule, and run history from this Dispatch
          instance.
        </p>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            variant="danger"
            size="sm"
            disabled={isRemoving}
            onClick={() => setRemoveDialogOpen(true)}
          >
            <Trash2 />
            Remove
          </Button>
        </div>
      </Card>
      <ConfirmDialog
        open={removeDialogOpen}
        onOpenChange={setRemoveDialogOpen}
        title={`Remove “${job.name}”?`}
        description="This removes the job’s saved schedule and run history from this Dispatch instance."
        confirmLabel="Remove job"
        errorTitle="Couldn’t remove the job."
        onConfirm={() => onRemoveJob(job)}
      />
    </div>
  );
}
