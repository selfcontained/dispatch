import { useState } from "react";
import { agentListQuery } from "@/hooks/use-agents";
import { useParams } from "react-router-dom";
import { LaunchTargetError } from "./launch-target-error";
import { RunnerPicker } from "./runner-picker";
import { RunnerProjectPicker } from "./runner-project-picker";
import { taskAgentName } from "@dispatch/shared";
import { panelFrame } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ProjectLocation } from "./project-location";
import { useProjectScope, useProjects } from "@/hooks/use-projects";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ChevronLeft } from "lucide-react";

import { AgentPersonaSelect } from "@/components/app/agent-persona-select";
import { AgentEngineFields } from "@/components/app/agent-engine-fields";
import { ContextPicker } from "@/components/app/context-picker";
import { CONTEXT_PROMPT_ID } from "@/components/app/create-agent-dialog-utils";
import { WorktreeSection } from "@/components/app/create-agent-worktree-section";
import { PathInput } from "@/components/app/path-input";
import { useCreateAgentForm } from "@/components/app/use-create-agent-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type Agent } from "@/components/app/types";
import { type AgentType } from "@/lib/agent-types";
import { Alert } from "@/components/ui/alert";
import { AsyncBoundary } from "@/components/ui/async-boundary";
import { Field } from "@/components/ui/field";
import { OptionCard } from "@/components/ui/setting-row";
import { Textarea } from "@/components/ui/textarea";

type CreateAgentDialogProps = {
  open: boolean;
  enabledAgentTypes: AgentType[];
  initialAgentType: AgentType | null;
  setOpen: (open: boolean) => void;
  resolveDefaultCwd: () => string;
  onCreated: (agent: Agent, agentType: AgentType) => Promise<void>;
  /** Creating for a task: briefed on it, assigned to it, in its project. */
  task?: { id: string; title: string; projectId: string } | null;
};

export function CreateAgentDialog({
  open,
  enabledAgentTypes,
  initialAgentType,
  setOpen,
  resolveDefaultCwd,
  onCreated,
  task = null,
}: CreateAgentDialogProps): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open ? (
        <CreateAgentDialogContent
          enabledAgentTypes={enabledAgentTypes}
          initialAgentType={initialAgentType}
          resolveDefaultCwd={resolveDefaultCwd}
          onCreated={onCreated}
          task={task}
        />
      ) : null}
    </Dialog>
  );
}

function CreateAgentDialogContent({
  enabledAgentTypes,
  initialAgentType,
  resolveDefaultCwd,
  onCreated,
  task = null,
}: Omit<CreateAgentDialogProps, "open" | "setOpen">): JSX.Element {
  const { agentId } = useParams();
  const { data: agents = [] } = useQuery<Agent[]>({
    ...agentListQuery,
    enabled: false,
  });
  const { project, projectId } = useProjectScope();
  const form = useCreateAgentForm({
    sourceAgentId:
      !task && agents.some((agent) => agent.id === agentId)
        ? agentId
        : undefined,
    enabledAgentTypes,
    initialAgentType,
    resolveDefaultCwd: () => project?.repoRoot ?? resolveDefaultCwd(),
    initialProjectId: projectId,
    task,
    onCreated,
  });

  const [localProjectMode, setLocalProjectMode] = useState(false);
  return (
    <DialogContent
      aria-describedby={
        form.step === "config" ? undefined : "create-agent-context-description"
      }
      busy={form.creating}
      onEscapeKeyDown={(e) => {
        if (form.step === "context" && !form.creating) {
          e.preventDefault();
          form.setStep("config");
        }
      }}
    >
      {form.step === "config" ? (
        <>
          <DialogHeader
            className={
              (form.launch.list.data?.length ?? 0) > 1
                ? "flex-row items-center justify-between gap-2 space-y-0"
                : undefined
            }
          >
            <DialogTitle>New agent</DialogTitle>
            <RunnerPicker
              live
              targets={form.launch.list.data ?? []}
              value={form.launch.key}
              onChange={form.chooseTarget}
            />
          </DialogHeader>

          <DialogForm
            data-testid="create-agent-form"
            onSubmit={(event) => void form.handleSubmit(event)}
          >
            <DialogBody className="space-y-3">
              <LaunchTargetError
                queries={[
                  form.launch.list,
                  form.launch.projection,
                  form.targetData,
                ]}
              />
              <AgentEngineFields
                agentType={form.createType}
                onAgentTypeChange={form.setCreateType}
                agentTypes={form.agentTypes}
                target={{ engines: form.engines, effort: form.workloadEffort }}
                effort={form.createEffort}
                onEffortChange={form.setCreateEffort}
                model={form.createModel}
                onModelChange={form.setCreateModel}
                modelOptions={form.modelOptions}
                catalogDefault={form.defaultModel}
                modelLoading={form.modelCatalogLoading}
              />

              <Field label="Name" optional>
                <Input
                  autoFocus
                  value={form.createName}
                  onChange={(event) => form.setCreateName(event.target.value)}
                  placeholder={
                    task
                      ? taskAgentName(task.title) || "agent name"
                      : "agent name"
                  }
                  data-testid="create-agent-name"
                />
              </Field>

              {task ? (
                <TaskContextCard task={task} />
              ) : form.launch.target?.location.kind === "project" ? (
                <RunnerProjectPicker
                  searchUrl={form.launch.target.location.repositorySearchUrl}
                  projects={form.launch.target.location.projects ?? []}
                  projectId={form.createProjectId}
                  loading={form.launch.list.isLoading}
                  error={Boolean(form.launch.target.location.error)}
                  onProject={form.setCreateProjectId}
                />
              ) : (
                <div className="space-y-1">
                  <ProjectLocation
                    projectId={form.createProjectId}
                    rememberedProjectId={form.lastProjectId}
                    onModeChange={setLocalProjectMode}
                    projectPicker={
                      form.launch.target?.location.repositorySearchUrl ? (
                        <RunnerProjectPicker
                          searchUrl={
                            form.launch.target.location.repositorySearchUrl
                          }
                          projects={form.launch.target.location.projects ?? []}
                          projectId={form.createProjectId}
                          loading={form.launch.list.isLoading}
                          error={Boolean(form.launch.target.location.error)}
                          onProject={form.setCreateProjectId}
                        />
                      ) : undefined
                    }
                    onChange={(p) => {
                      form.setCreateProjectId(p?.id ?? null);
                    }}
                  >
                    <PathInput
                      value={form.createCwd}
                      onChange={form.setCreateCwd}
                      history={form.cwdHistory}
                      historyUrl={form.historyUrl}
                      removableHistory={form.removableCwdHistory}
                      historyMetadata={form.cwdHistoryMetadata}
                      onRemoveHistory={form.removeCwdHistory}
                      onPathInfoChange={form.handlePathInfoChange}
                      data-testid="create-agent-cwd"
                      historyItemTestId="create-agent-cwd-history-option"
                    />
                  </ProjectLocation>
                </div>
              )}

              <AgentPersonaSelect
                cwd={form.createCwd}
                endpoint={
                  form.createCwd.trim() || form.createProjectId
                    ? (form.targetData.data?.personasUrl ?? "")
                    : undefined
                }
                value={form.createPersona}
                onChange={form.setCreatePersona}
              />
              <WorktreeSection
                cwd={form.createCwd}
                branchesUrl={form.targetData.branchesUrl}
                defaultBaseBranch={form.targetData.defaultBaseBranch}
                reserveExpandedSpace={
                  form.launch.target?.location.kind === "project" ||
                  (localProjectMode && !form.createProjectId) ||
                  Boolean(form.createProjectId && !form.createCwd)
                }
                worktreeAvailable={form.worktreeAvailable}
                useWorktree={form.createUseWorktree}
                onUseWorktreeChange={form.setCreateUseWorktree}
                baseBranch={form.createBaseBranch}
                onBaseBranchChange={form.setCreateBaseBranch}
                worktreeBranch={form.createWorktreeBranch}
                onWorktreeBranchChange={form.setCreateWorktreeBranch}
                createNewBranch={form.createNewBranch}
                onCreateNewBranchChange={form.setCreateNewBranch}
              />

              {form.createType !== "opencode" && (
                <OptionCard
                  label="Start in full access mode"
                  description="Skip permission prompts. Turn off to require approvals."
                >
                  <Checkbox
                    checked={form.createFullAccess}
                    onCheckedChange={() =>
                      form.setCreateFullAccess((current) => !current)
                    }
                  />
                </OptionCard>
              )}
            </DialogBody>
            <CreateFailure error={form.submitError} />
            <DialogFooter
              start={
                <Button
                  type="button"
                  tabIndex={0}
                  disabled={
                    form.creating ||
                    !form.locationReady ||
                    (!form.createProjectId && !form.createCwd.trim())
                  }
                  data-testid="create-agent-with-context"
                  onClick={form.enterContextStep}
                >
                  Add context
                </Button>
              }
            >
              <DialogCancel tabIndex={0} data-testid="create-agent-cancel" />
              <Button
                type="submit"
                variant="primary"
                tabIndex={0}
                pending={form.creating}
                disabled={!form.locationReady}
                data-testid="create-agent-submit"
              >
                Create agent
              </Button>
            </DialogFooter>
          </DialogForm>
        </>
      ) : (
        <>
          <DialogHeader>
            <DialogTitle>New agent with context</DialogTitle>
            <DialogDescription id="create-agent-context-description">
              Add startup instructions, files, and links for the agent to use
              when the session starts.
            </DialogDescription>
          </DialogHeader>

          <DialogForm
            data-testid="create-agent-context-form"
            onSubmit={(event) => void form.handleSubmit(event)}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) {
                event.preventDefault();
                form.setDraggingFiles(true);
              }
            }}
            onDragLeave={(event) => {
              if (
                event.currentTarget.contains(event.relatedTarget as Node | null)
              ) {
                return;
              }
              form.setDraggingFiles(false);
            }}
            onDrop={form.handleStartupDrop}
          >
            <DialogBody className="space-y-3">
              <Field id={CONTEXT_PROMPT_ID} label="Instructions">
                <Textarea
                  ref={form.promptTextareaRef}
                  value={form.initialPrompt}
                  onChange={(event) =>
                    form.setInitialPrompt(event.target.value)
                  }
                  onPaste={form.handleStartupPaste}
                  placeholder="Enter instructions for the agent..."
                  data-testid="create-agent-initial-prompt"
                  className="min-h-[180px] resize-y"
                />
              </Field>

              <ContextPicker
                error={form.attachmentError}
                files={form.startupFiles}
                links={form.startupLinks}
                draggingFiles={form.draggingFiles}
                filePreviewsRef={form.startupFilePreviewsRef}
                onAppendFiles={form.appendStartupFiles}
                onRemoveFile={form.handleRemoveStartupFile}
                onAddLink={form.handleAddLink}
                onRemoveLink={form.handleRemoveStartupLink}
                onClipboardText={form.handleClipboardText}
                onDraftInvalid={form.setContextDraftInvalid}
                testIdPrefix="create-agent-context"
              />
            </DialogBody>
            <CreateFailure error={form.submitError} />
            <DialogFooter
              start={
                <Button
                  type="button"
                  variant="ghost"
                  tabIndex={0}
                  disabled={form.creating}
                  onClick={() => form.setStep("config")}
                  data-testid="create-agent-context-back"
                >
                  <ChevronLeft />
                  Back
                </Button>
              }
            >
              <DialogCancel tabIndex={0} />
              <Button
                type="submit"
                variant="primary"
                tabIndex={0}
                pending={form.creating}
                disabled={!form.locationReady || form.contextDraftInvalid}
                data-testid="create-agent-context-submit"
              >
                Create agent
              </Button>
            </DialogFooter>
          </DialogForm>
        </>
      )}
    </DialogContent>
  );
}

function CreateFailure({ error }: { error: unknown }) {
  return error ? (
    <Alert title="Couldn’t create the agent." error={error} />
  ) : null;
}

/**
 * Where an agent created for a task lives and what it is told: the task's
 * project is not a choice, and the briefing that rides along with the
 * prompt can be read before launching.
 */
function TaskContextCard({
  task,
}: {
  task: { id: string; title: string; projectId: string };
}): JSX.Element {
  const { data: projects = [] } = useProjects();
  const project = projects.find((item) => item.id === task.projectId);
  const briefing = useQuery({
    queryKey: ["tasks", "briefing", task.id],
    queryFn: () =>
      api<{ projectId: string; text: string }>(
        `/api/v1/tasks/${encodeURIComponent(task.id)}/briefing`
      ),
  });
  return (
    <section
      data-testid="create-agent-task"
      className={cn(panelFrame, "space-y-2 p-3 text-body-md")}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate">
          <span className="text-muted-foreground">Task </span>
          {task.title}
        </span>
        <span
          className="shrink-0 truncate font-mono text-body-sm text-muted-foreground"
          title={project?.repoRoot ?? undefined}
        >
          {project?.name ?? "…"}
        </span>
      </div>
      <details className="group text-body-sm">
        <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
          What the agent is told
        </summary>
        <AsyncBoundary query={briefing} thing="the briefing" className="mt-2">
          {({ text }) => (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-sm bg-background/veil p-2 font-mono text-label-sm leading-snug text-muted-foreground">
              {text}
            </pre>
          )}
        </AsyncBoundary>
      </details>
    </section>
  );
}
