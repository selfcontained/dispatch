import { taskAgentName } from "@dispatch/shared";
import { ProjectLocation } from "./project-location";
import { useProjectScope, useProjects } from "@/hooks/use-projects";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMemo, useState } from "react";
import { ChevronLeft } from "lucide-react";

import { AgentPersonaSelect } from "@/components/app/agent-persona-select";
import { AgentModelSelect } from "@/components/app/agent-model-select";
import { engineSummary, useEngines } from "@/hooks/use-engines";
import { AgentTypeSelect } from "@/components/app/agent-type-select";
import { ContextPicker } from "@/components/app/context-picker";
import { CONTEXT_PROMPT_ID } from "@/components/app/create-agent-dialog-utils";
import { WorktreeSection } from "@/components/app/create-agent-worktree-section";
import { PathInput } from "@/components/app/path-input";
import { useCreateAgentForm } from "@/components/app/use-create-agent-form";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type Agent } from "@/components/app/types";
import { useRadixPopoverZFix } from "@/hooks/use-radix-popover-z-fix";
import { type AgentType } from "@/lib/agent-types";
import { swallowEscapeFromCombobox } from "@/lib/dialog-escape";
import { cn } from "@/lib/utils";

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
          setOpen={setOpen}
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
  setOpen,
  resolveDefaultCwd,
  onCreated,
  task = null,
}: Omit<CreateAgentDialogProps, "open">): JSX.Element {
  const { project, projectId } = useProjectScope();
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  // Engines whose CLI this machine does not have: pickable, but the picker
  // says what to install rather than letting the launch fail.
  const { engines } = useEngines();
  const missingEngines = useMemo(
    () =>
      Object.fromEntries(
        engines
          .filter((engine) => !engine.installed)
          .map((engine) => [
            engine.id,
            { label: engine.label, install: engine.install },
          ])
      ),
    [engines]
  );
  const form = useCreateAgentForm({
    enabledAgentTypes,
    initialAgentType,
    resolveDefaultCwd: () => project?.repoRoot ?? resolveDefaultCwd(),
    initialProjectId: projectId,
    task,
    onCreated,
  });

  useRadixPopoverZFix();
  const engineLine = engineSummary(engines, form.createType);
  const showModelSelect =
    form.modelCatalogLoading || form.modelOptions.length > 0;

  return (
    <DialogContent
      aria-describedby={
        form.step === "config" ? undefined : "create-agent-context-description"
      }
      onEscapeKeyDown={(e) => {
        swallowEscapeFromCombobox(e);
        if (e.defaultPrevented) return;
        if (typeDropdownOpen) {
          e.preventDefault();
        }
        if (form.step === "context") {
          e.preventDefault();
          form.setStep("config");
        }
      }}
    >
      {form.step === "config" ? (
        <>
          <DialogHeader>
            <DialogTitle>Create Agent</DialogTitle>
          </DialogHeader>

          <form
            data-testid="create-agent-form"
            className="flex min-h-0 flex-col"
            onSubmit={(event) => void form.handleSubmit(event)}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-1">
              <div className="space-y-3">
                <div
                  className={cn(
                    "grid gap-3",
                    showModelSelect && "min-[420px]:grid-cols-2"
                  )}
                >
                  <AgentTypeSelect
                    value={form.createType}
                    onChange={form.setCreateType}
                    agentTypes={enabledAgentTypes}
                    onOpenChange={setTypeDropdownOpen}
                    missing={missingEngines}
                  />

                  {showModelSelect ? (
                    <AgentModelSelect
                      value={form.createModel}
                      options={form.modelOptions}
                      onChange={form.setCreateModel}
                      loading={form.modelCatalogLoading}
                    />
                  ) : null}
                </div>
                {engineLine ? (
                  <p
                    className="-mt-1 truncate text-xs text-muted-foreground/70"
                    title={engineLine}
                    data-testid="create-agent-engine"
                  >
                    {engineLine}
                  </p>
                ) : null}

                <div className="space-y-1">
                  <label className="text-sm text-muted-foreground">
                    Name{" "}
                    <span className="text-muted-foreground/70">(optional)</span>
                  </label>
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
                </div>

                {task ? (
                  <TaskContextCard task={task} />
                ) : (
                  <div className="space-y-1">
                    <ProjectLocation
                      projectId={form.createProjectId}
                      rememberedProjectId={form.lastProjectId}
                      onChange={(p) => {
                        form.setCreateProjectId(p?.id ?? null);
                      }}
                    >
                      <PathInput
                        value={form.createCwd}
                        onChange={form.setCreateCwd}
                        history={form.cwdHistory}
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
                  value={form.createPersona}
                  onChange={form.setCreatePersona}
                />
                <WorktreeSection
                  cwd={form.createCwd}
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

                <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3">
                  <Checkbox
                    checked={form.createFullAccess}
                    onCheckedChange={() =>
                      form.setCreateFullAccess((current) => !current)
                    }
                    className="mt-0.5"
                    title="Toggle full access"
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium text-foreground">
                      Start in full access mode
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Skip permission prompts. Turn off to require approvals.
                    </span>
                  </span>
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-3">
              <Button
                type="button"
                variant="ghost"
                tabIndex={0}
                onClick={() => setOpen(false)}
                data-testid="create-agent-cancel"
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="default"
                tabIndex={0}
                disabled={
                  form.creating || !form.locationReady || !form.createCwd.trim()
                }
                data-testid="create-agent-with-context"
                onClick={form.enterContextStep}
              >
                Create with context
              </Button>
              <Button
                type="submit"
                variant="primary"
                tabIndex={0}
                disabled={form.creating || !form.locationReady}
                data-testid="create-agent-submit"
              >
                {form.creating ? (
                  <ActivityBars size={16} className="mr-1.5" />
                ) : null}
                Create
              </Button>
            </div>
          </form>
        </>
      ) : (
        <>
          <DialogHeader>
            <DialogTitle>Create with context</DialogTitle>
            <DialogDescription id="create-agent-context-description">
              Add startup instructions, files, and links for the agent to use
              when the session starts.
            </DialogDescription>
          </DialogHeader>

          <form
            data-testid="create-agent-context-form"
            className="flex min-h-0 flex-1 flex-col"
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
            <div
              className={cn(
                "min-h-0 flex-1 overflow-y-auto rounded-lg px-1 pb-1"
              )}
            >
              <div className="space-y-3">
                <div className="space-y-1">
                  <label
                    htmlFor={CONTEXT_PROMPT_ID}
                    className="text-sm text-muted-foreground"
                  >
                    Instructions
                  </label>
                  <textarea
                    id={CONTEXT_PROMPT_ID}
                    ref={form.promptTextareaRef}
                    value={form.initialPrompt}
                    onChange={(event) =>
                      form.setInitialPrompt(event.target.value)
                    }
                    onPaste={form.handleStartupPaste}
                    placeholder="Enter instructions for the agent..."
                    data-testid="create-agent-initial-prompt"
                    className={cn(
                      "flex min-h-[180px] w-full resize-y rounded-md border border-white/[0.12] bg-white/[0.04] px-3 py-2 text-sm shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] backdrop-blur-md",
                      "ring-offset-background placeholder:text-muted-foreground",
                      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    )}
                  />
                </div>

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
              </div>
            </div>

            <div className="flex justify-between gap-2 border-t border-white/[0.08] pt-3">
              <Button
                type="button"
                variant="ghost"
                tabIndex={0}
                className="min-h-11 px-3"
                onClick={() => form.setStep("config")}
                data-testid="create-agent-context-back"
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Back
              </Button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  tabIndex={0}
                  className="min-h-11 px-3"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  tabIndex={0}
                  className="min-h-11 px-3"
                  disabled={
                    form.creating ||
                    !form.locationReady ||
                    form.contextDraftInvalid
                  }
                  data-testid="create-agent-context-submit"
                >
                  {form.creating ? (
                    <ActivityBars size={16} className="mr-1.5" />
                  ) : null}
                  Create
                </Button>
              </div>
            </div>
          </form>
        </>
      )}
    </DialogContent>
  );
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
      className="space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2.5 text-sm"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate">
          <span className="text-muted-foreground">Task </span>
          {task.title}
        </span>
        <span
          className="shrink-0 truncate font-mono text-xs text-muted-foreground"
          title={project?.repoRoot}
        >
          {project?.name ?? "…"}
        </span>
      </div>
      <details className="group text-xs">
        <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
          What the agent is told
        </summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background/60 p-2 font-mono text-[11px] leading-snug text-muted-foreground">
          {briefing.data?.text ??
            (briefing.error ? "Could not load the briefing." : "Loading…")}
        </pre>
      </details>
    </section>
  );
}
