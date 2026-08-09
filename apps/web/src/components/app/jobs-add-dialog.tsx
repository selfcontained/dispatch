import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronDown, X } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { PathInput } from "@/components/app/path-input";
import { AgentModelSelect } from "@/components/app/agent-model-select";
import { api } from "@/lib/api";
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
  cronError,
  errorMessage,
  msFromMinutes,
} from "@/components/app/jobs-helpers";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type AddJobConfig } from "@/hooks/use-jobs";
import {
  type AgentType,
  type CliAgentType,
  isCliAgentType,
} from "@/lib/agent-types";
import { swallowEscapeFromCombobox } from "@/lib/dialog-escape";
import { cn } from "@/lib/utils";

export function AddJobDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-md" />
        <DialogPrimitive.Content
          onEscapeKeyDown={swallowEscapeFromCombobox}
          className="fixed inset-x-2 bottom-2 top-2 z-50 flex max-h-[calc(100dvh-1rem)] flex-col overflow-hidden rounded-lg border border-white/[0.2] bg-[hsl(var(--card))] backdrop-blur-2xl shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)] outline-none md:left-1/2 md:top-1/2 md:h-[min(760px,88vh)] md:w-[min(760px,calc(100vw-2rem))] md:-translate-x-1/2 md:-translate-y-1/2"
        >
          <DialogPrimitive.Title className="sr-only">
            Add job
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Create a new recurring Dispatch job.
          </DialogPrimitive.Description>
          <DialogPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-3 top-3 z-10"
              aria-label="Close add job"
            >
              <X className="h-4 w-4" />
            </Button>
          </DialogPrimitive.Close>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
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
  const [directory, setDirectory] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState("");
  const [timeoutMinutes, setTimeoutMinutes] = useState("30");
  const [needsInputTimeoutMinutes, setNeedsInputTimeoutMinutes] =
    useState("1440");
  const jobAgentTypes = enabledAgentTypes.filter(isCliAgentType);
  const [agentType, setAgentType] = useState<CliAgentType>(
    jobAgentTypes[0] ?? "codex"
  );
  const [model, setModel] = useState<string | null>(null);
  const { data: modelCatalog, isLoading: modelCatalogLoading } = useQuery<{
    models: Partial<Record<CliAgentType, Array<{ id: string; label: string }>>>;
  }>({
    queryKey: ["agent-models"],
    queryFn: () => api("/api/v1/agent-models"),
  });
  const modelOptions = modelCatalog?.models[agentType] ?? [];
  const [fullAccess, setFullAccess] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [baseBranch, setBaseBranch] = useState("main");
  const [branchName, setBranchName] = useState("");
  const [keepAgent, setKeepAgent] = useState(false);
  const [callable, setCallable] = useState(false);
  const [singleton, setSingleton] = useState(true);
  const [enableImmediately, setEnableImmediately] = useState(false);
  const [selfImprove, setSelfImprove] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const {
    history: cwdHistory,
    removableHistory: removableCwdHistory,
    historyMetadata: cwdHistoryMetadata,
    add: addCwdHistory,
    remove: removeCwdHistory,
  } = useCwdHistory();
  const effectiveEnabled = schedule.trim() ? enableImmediately : false;
  const scheduleError = cronError(schedule, effectiveEnabled);
  const canAdd =
    !!displayName.trim() &&
    !!directory.trim() &&
    !!prompt.trim() &&
    !scheduleError &&
    !!msFromMinutes(timeoutMinutes) &&
    !!msFromMinutes(needsInputTimeoutMinutes);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-hidden p-4 md:p-8">
      <div className="text-lg font-semibold">Create a new job</div>
      <p className="mt-1 text-sm text-muted-foreground">
        Define an automation with a prompt — on a schedule or on demand.
      </p>

      <ScrollArea className="mt-6 min-h-0 flex-1 pr-1">
        <div className="grid min-w-0 gap-4">
          <div className="min-w-0 rounded-md border border-white/[0.12] bg-white/[0.04] p-4">
            <div className="grid min-w-0 gap-3 md:grid-cols-2">
              <div className="min-w-0 space-y-1 md:col-span-2">
                <label
                  className="text-sm text-muted-foreground"
                  htmlFor="job-display-name"
                >
                  Name
                </label>
                <Input
                  id="job-display-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="e.g. Daily cleanup"
                />
              </div>
              <div className="min-w-0 space-y-1 md:col-span-2">
                <label
                  className="text-sm text-muted-foreground"
                  htmlFor="job-directory"
                >
                  Working directory
                </label>
                <PathInput
                  value={directory}
                  onChange={setDirectory}
                  label=""
                  placeholder="~/code/project"
                  id="job-directory"
                  history={cwdHistory}
                  removableHistory={removableCwdHistory}
                  historyMetadata={cwdHistoryMetadata}
                  onRemoveHistory={removeCwdHistory}
                  data-testid="job-directory-input"
                />
              </div>
              <JobScheduleField
                id="job-schedule"
                schedule={schedule}
                scheduleError={scheduleError}
                enabled={enableImmediately}
                enabledHelperText="Run this job on its schedule after creating it."
                onScheduleChange={setSchedule}
                onEnabledChange={setEnableImmediately}
              />
              <div className="grid gap-3 min-[420px]:grid-cols-2 md:col-span-2">
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
              </div>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm md:col-span-2">
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
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm md:col-span-2">
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
            </div>
          </div>

          <div className="min-w-0 rounded-md border border-border bg-muted/20 p-4">
            <div className="space-y-1">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="job-prompt"
              >
                Prompt
              </label>
              <p className="text-xs text-muted-foreground">
                The instructions the agent will follow when this job runs.
              </p>
            </div>
            <textarea
              id="job-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe what the agent should do..."
              className="mt-2 min-h-64 w-full rounded-md border border-white/[0.12] bg-white/[0.04] backdrop-blur-md shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
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
          </div>

          <div className="min-w-0 rounded-md border border-white/[0.12] bg-white/[0.04] p-4">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 text-left"
              onClick={() => setAdvancedOpen((current) => !current)}
            >
              <div>
                <div className="text-sm font-medium">Advanced settings</div>
                <div className="mt-1 text-xs text-muted-foreground">
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
            </button>
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
                  <div className="min-w-0 space-y-1">
                    <label
                      className="text-sm text-muted-foreground"
                      htmlFor="job-timeout"
                    >
                      Run timeout, minutes
                    </label>
                    <Input
                      id="job-timeout"
                      value={timeoutMinutes}
                      onChange={(event) =>
                        setTimeoutMinutes(event.target.value)
                      }
                      inputMode="numeric"
                    />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <label
                      className="text-sm text-muted-foreground"
                      htmlFor="job-needs-input-timeout"
                    >
                      Wait for input, minutes
                    </label>
                    <Input
                      id="job-needs-input-timeout"
                      value={needsInputTimeoutMinutes}
                      onChange={(event) =>
                        setNeedsInputTimeoutMinutes(event.target.value)
                      }
                      inputMode="numeric"
                    />
                  </div>
                  <JobWorktreeOption
                    checked={useWorktree}
                    cwd={directory}
                    baseBranch={baseBranch}
                    branchName={branchName}
                    onCheckedChange={setUseWorktree}
                    onBaseBranchChange={setBaseBranch}
                    onBranchNameChange={setBranchName}
                    testIdPrefix="job-create"
                  />
                  <JobFullAccessOption
                    checked={fullAccess}
                    onCheckedChange={setFullAccess}
                  />
                  <JobKeepAgentOption
                    checked={keepAgent}
                    onCheckedChange={setKeepAgent}
                  />
                </div>
              </div>
            </div>
          </div>

          {submitError ? (
            <div className="rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">
              {submitError}
            </div>
          ) : null}
        </div>
      </ScrollArea>

      <div className="mt-4 flex shrink-0 justify-end gap-2 border-t border-border/70 pt-4">
        <DialogPrimitive.Close asChild>
          <Button variant="ghost">Cancel</Button>
        </DialogPrimitive.Close>
        <Button
          variant="primary"
          disabled={!canAdd || isAdding}
          onClick={() => {
            setSubmitError(null);
            const trimmedDirectory = directory.trim();
            void onAddJob({
              name: displayName.trim(),
              directory: trimmedDirectory,
              displayName: displayName.trim(),
              prompt: prompt.trim(),
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
              enabled: effectiveEnabled,
              selfImprove,
            })
              .then(() => addCwdHistory(trimmedDirectory))
              .catch((error) => setSubmitError(errorMessage(error)));
          }}
        >
          {isAdding ? <ActivityBars size={16} className="mr-2" /> : null}
          Add job
        </Button>
      </div>
    </div>
  );
}
