import { AgentConfigRow } from "./agent-config-row";
import type { Effort } from "@dispatch/shared";
import { AgentEffortSelect } from "./agent-effort-select";
import { ProjectLocation } from "./project-location";
import { useProjectScope } from "@/hooks/use-projects";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LaunchTargetError } from "./launch-target-error";
import { RunnerPicker } from "./runner-picker";
import { RunnerProjectPicker } from "./runner-project-picker";
import { useJobTarget } from "./use-job-target";

import { PathInput } from "@/components/app/path-input";
import { AgentPersonaSelect } from "@/components/app/agent-persona-select";
import { AgentModelSelect } from "@/components/app/agent-model-select";
import { useCwdHistory } from "@/components/app/create-agent-dialog-utils";
import {
  JobAgentTypeField,
  JobFullAccessOption,
  JobKeepAgentOption,
  JobScheduleField,
  JobWorktreeOption,
  SwitchToggle,
} from "@/components/app/jobs-form-fields";
import {
  LoopSetup,
  continuationMaxIterations,
  defaultContinuationDraft,
  normalizeLoopItems,
} from "@/components/app/jobs-continuation-fields";
import { cronError, msFromMinutes } from "@/components/app/jobs-helpers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RowButton } from "@/components/ui/row-button";
import { type AddJobConfig } from "@/hooks/use-jobs";
import {
  type AgentType,
  type CliAgentType,
  isCliAgentType,
} from "@/lib/agent-types";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { SettingRow } from "@/components/ui/setting-row";
import { Textarea } from "@/components/ui/textarea";

export function AddJobDialog({
  open,
  onOpenChange,
  busy,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" phone="fill" busy={busy}>
        <DialogHeader>
          <DialogTitle>New job</DialogTitle>
          <DialogDescription>
            Define an automation with a prompt — on a schedule or on demand.
          </DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function AddJobFlow({
  onAddJob,
  isAdding,
  enabledAgentTypes,
}: {
  onAddJob: (job: AddJobConfig) => Promise<void>;
  isAdding: boolean;
  enabledAgentTypes: AgentType[];
}) {
  const [displayName, setDisplayName] = useState("");
  const { project } = useProjectScope();
  const [projectId, setProjectId] = useState<string | null>(
    project?.id ?? null
  );
  const [directory, setDirectory] = useState(project?.repoRoot ?? "");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState("");
  const [timeoutMinutes, setTimeoutMinutes] = useState("30");
  const [needsInputTimeoutMinutes, setNeedsInputTimeoutMinutes] =
    useState("1440");
  const jobAgentTypes = enabledAgentTypes.filter(isCliAgentType);
  const [agentType, setAgentType] = useState<CliAgentType>(
    jobAgentTypes[0] ?? "codex"
  );
  const [persona, setPersona] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  const [model, setModel] = useState<string | null>(null);
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
    directory,
    projectId,
    agentType,
    model,
    onAgentTypes: onTargetAgentTypes,
  });
  const { options: modelOptions, loading: modelCatalogLoading } = target.models;
  const [fullAccess, setFullAccess] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [baseBranch, setBaseBranch] = useState("main");
  // Main for a folder; a project launched from its repository starts at
  // that repository's default branch (empty), unless one was picked.
  const repositoryBase = useRef(false);
  const startBase = target.byRepository
    ? target.data.data?.defaults.baseBranch
    : "main";
  useEffect(() => {
    if (startBase === undefined) return;
    setBaseBranch((old) => {
      if (startBase === "" && old === "main") {
        repositoryBase.current = true;
        return "";
      }
      if (startBase && repositoryBase.current && old === "") {
        repositoryBase.current = false;
        return startBase;
      }
      return old;
    });
  }, [startBase]);
  const [branchName, setBranchName] = useState("");
  const [keepAgent, setKeepAgent] = useState(false);
  const [callable, setCallable] = useState(false);
  const [singleton, setSingleton] = useState(true);
  const [enableImmediately, setEnableImmediately] = useState(false);
  const [selfImprove, setSelfImprove] = useState(false);
  const [continuation, setContinuation] = useState(defaultContinuationDraft);
  const [submitError, setSubmitError] = useState<unknown>();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const {
    history: cwdHistory,
    removableHistory: removableCwdHistory,
    historyMetadata: cwdHistoryMetadata,
    add: addCwdHistory,
    remove: removeCwdHistory,
  } = useCwdHistory();
  const effectiveEnabled =
    schedule.trim() || continuation.enabled ? enableImmediately : false;
  const scheduleError = cronError(
    schedule,
    effectiveEnabled,
    continuation.enabled
  );
  const canAdd =
    !!displayName.trim() &&
    target.launch.selectionReady &&
    (target.byProject
      ? target.projects.some((p) => p.id === projectId)
      : !!directory.trim() || target.byRepository) &&
    !!prompt.trim() &&
    !scheduleError &&
    (!continuation.enabled ||
      !continuation.maxIterations.trim() ||
      Boolean(continuationMaxIterations(continuation.maxIterations))) &&
    !!msFromMinutes(timeoutMinutes) &&
    !!msFromMinutes(needsInputTimeoutMinutes);

  return (
    <>
      <DialogBody className="grid min-w-0 gap-4">
        <div className="min-w-0">
          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            <div className="min-w-0 space-y-3 empty:hidden md:col-span-2">
              <RunnerPicker
                targets={target.launch.list.data ?? []}
                value={target.launch.key}
                onChange={(key) => {
                  setModel(null);
                  setEffort(null);
                  setPersona(null);
                  setProjectId(null);
                  setDirectory("");
                  setBaseBranch(
                    target.launch.list.data?.find((t) => t.key === key)
                      ?.defaultBaseBranch ?? "main"
                  );
                  target.launch.choose(key);
                }}
              />
              <LaunchTargetError queries={[target.launch.list, target.data]} />
            </div>
            <Field id="job-display-name" label="Name" className="md:col-span-2">
              <Input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="e.g. Daily cleanup"
              />
            </Field>
            {target.byProject ? (
              <div className="min-w-0 md:col-span-2">
                <RunnerProjectPicker
                  searchUrl={target.searchUrl}
                  projects={target.projects}
                  projectId={projectId}
                  loading={target.launch.list.isLoading}
                  error={Boolean(target.launch.target?.location.error)}
                  onProject={setProjectId}
                />
              </div>
            ) : (
              <div className="min-w-0 space-y-1 md:col-span-2">
                <ProjectLocation
                  projectId={projectId}
                  projectPicker={
                    target.searchUrl ? (
                      <RunnerProjectPicker
                        searchUrl={target.searchUrl}
                        projects={target.projects}
                        projectId={projectId}
                        loading={target.launch.list.isLoading}
                        error={Boolean(target.launch.target?.location.error)}
                        onProject={(id) => {
                          setProjectId(id);
                          setDirectory(
                            target.projects.find((p) => p.id === id)
                              ?.repoRoot ?? ""
                          );
                        }}
                      />
                    ) : undefined
                  }
                  onChange={(p) => {
                    setProjectId(p?.id ?? null);
                    if (p) setDirectory(p.repoRoot ?? "");
                  }}
                >
                  <PathInput
                    value={directory}
                    onChange={setDirectory}
                    placeholder="~/code/project"
                    id="job-directory"
                    history={cwdHistory}
                    removableHistory={removableCwdHistory}
                    historyMetadata={cwdHistoryMetadata}
                    onRemoveHistory={removeCwdHistory}
                    data-testid="job-directory-input"
                  />
                </ProjectLocation>
              </div>
            )}
            <AgentPersonaSelect
              cwd={directory}
              endpoint={
                target.byRepository
                  ? projectId
                    ? (target.data.data?.personasUrl ?? "")
                    : ""
                  : undefined
              }
              value={persona}
              onChange={setPersona}
            />
            <JobScheduleField
              id="job-schedule"
              schedule={schedule}
              scheduleError={scheduleError}
              enabled={enableImmediately}
              enabledHelperText={
                continuation.enabled
                  ? "Allow manual or scheduled starts after creating it."
                  : "Run this job on its schedule after creating it."
              }
              showEnabledWithoutSchedule={continuation.enabled}
              onScheduleChange={setSchedule}
              onEnabledChange={setEnableImmediately}
            />
            <AgentConfigRow
              className="md:col-span-2"
              showModel={modelOptions.length > 0 || modelCatalogLoading}
            >
              <JobAgentTypeField
                value={agentType}
                agentTypes={target.data.info?.agentTypes || enabledAgentTypes}
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
                  onChange={(value) => {
                    setModel(value);
                    setEffort(null);
                  }}
                  loading={modelCatalogLoading}
                />
              ) : null}
              <AgentEffortSelect
                model={model}
                workload
                workloadChoices={target.data.effort}
                value={effort}
                onChange={setEffort}
                agentType={agentType}
                id="create-job-effort"
              />
            </AgentConfigRow>
            <SettingRow
              className="md:col-span-2"
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
              className="md:col-span-2"
              label="Single instance"
              description="Only allow one active run at a time."
            >
              <SwitchToggle
                checked={singleton}
                onCheckedChange={setSingleton}
                ariaLabel="Single instance"
              />
            </SettingRow>
          </div>
        </div>

        <div className="min-w-0 space-y-3">
          <Field
            id="job-prompt"
            label="Task prompt"
            hint="What each run should work on."
          >
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe what the agent should do..."
              className="min-h-64"
            />
          </Field>
          <SettingRow
            label="Self improve after each run"
            description="Let the agent update this job's saved prompt when it finds a durable improvement."
          >
            <SwitchToggle
              checked={selfImprove}
              onCheckedChange={setSelfImprove}
              ariaLabel="Self improve after each run"
            />
          </SettingRow>
        </div>

        <LoopSetup
          draft={continuation}
          onChange={(next) => {
            setContinuation(next);
            if (next.enabled) {
              if (!continuation.enabled) setEnableImmediately(true);
              setKeepAgent(false);
            } else if (!schedule.trim()) {
              setEnableImmediately(false);
            }
          }}
          idPrefix="job-continuation"
        />

        <Card className="min-w-0 p-4">
          <RowButton
            aria-expanded={advancedOpen}
            className="justify-between gap-3 rounded-sm hover:bg-transparent"
            onClick={() => setAdvancedOpen((current) => !current)}
          >
            <div>
              <div className="text-body-md font-medium">Advanced settings</div>
              <div className="mt-1 text-body-sm text-muted-foreground">
                Timeouts, worktree, permissions, and whether the agent is kept
                after running.
              </div>
            </div>
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                advancedOpen && "rotate-180"
              )}
            />
          </RowButton>
          <div
            className={cn(
              "grid min-w-0 overflow-hidden transition-all duration-200 ease-out",
              advancedOpen
                ? "mt-4 grid-rows-[1fr] opacity-100"
                : "mt-0 grid-rows-[0fr] opacity-0"
            )}
            aria-hidden={!advancedOpen}
          >
            <div className="min-h-0">
              <div className="grid min-w-0 gap-3 md:grid-cols-2">
                <Field id="job-timeout" label="Run timeout, minutes">
                  <Input
                    value={timeoutMinutes}
                    onChange={(event) => setTimeoutMinutes(event.target.value)}
                    inputMode="numeric"
                  />
                </Field>
                <Field
                  id="job-needs-input-timeout"
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
                <JobWorktreeOption
                  checked={useWorktree}
                  cwd={directory}
                  baseBranch={baseBranch}
                  branchName={branchName}
                  onCheckedChange={setUseWorktree}
                  onBaseBranchChange={setBaseBranch}
                  onBranchNameChange={setBranchName}
                  branchesUrl={
                    target.byRepository ? target.data.branchesUrl : undefined
                  }
                  defaultBaseBranch={
                    target.byRepository
                      ? target.data.defaultBaseBranch
                      : undefined
                  }
                  testIdPrefix="job-create"
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
                  disabled={continuation.enabled}
                  helperText={
                    continuation.enabled
                      ? "Unavailable while the loop is on."
                      : undefined
                  }
                />
              </div>
            </div>
          </div>
        </Card>
      </DialogBody>
      {submitError ? (
        <Alert title="Couldn’t create the job." error={submitError} />
      ) : null}
      <DialogFooter>
        <DialogCancel />
        <Button
          variant="primary"
          pending={isAdding}
          disabled={!canAdd}
          onClick={() => {
            setSubmitError(undefined);
            const trimmedDirectory = directory.trim();
            void onAddJob({
              name: displayName.trim(),
              directory: target.byProject ? "" : trimmedDirectory,
              ...target.launch.fields,
              projectId,
              displayName: displayName.trim(),
              prompt: prompt.trim(),
              schedule: schedule.trim() || null,
              timeoutMs: msFromMinutes(timeoutMinutes),
              needsInputTimeoutMs: msFromMinutes(needsInputTimeoutMinutes),
              agentType,
              model,
              effort,
              persona,
              useWorktree,
              baseBranch: useWorktree ? baseBranch : null,
              branchName: useWorktree ? branchName : null,
              fullAccess: agentType === "opencode" || fullAccess,
              autoArchive: continuation.enabled ? true : !keepAgent,
              callable,
              singleton,
              enabled: effectiveEnabled,
              selfImprove,
              ...(continuation.enabled
                ? {
                    continuationEnabled: true,
                    maxIterations: continuationMaxIterations(
                      continuation.maxIterations
                    ),
                    completionCriteria: normalizeLoopItems(
                      continuation.completionCriteria
                    ),
                    recoveryInstructions:
                      continuation.recoveryInstructions.trim() || null,
                  }
                : {}),
            })
              .then(() => {
                if (!target.byRepository) addCwdHistory(trimmedDirectory);
              })
              .catch(setSubmitError);
          }}
        >
          Create job
        </Button>
      </DialogFooter>
    </>
  );
}
