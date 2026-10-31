import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useTemplates } from "@/hooks/use-templates";
import { useProjects } from "@/hooks/use-projects";
import { useTaskActions, type Task, type TaskColumn } from "@/hooks/use-tasks";
import type {
  TaskLaunchPreview,
  TaskLaunchTemplateOperation,
} from "../../../../../server/src/tasks/types";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function useTaskLaunchPreview(
  projectId: string,
  columnId: string,
  templateId: string | null,
  refreshKey?: string
) {
  const { data: templates = [] } = useTemplates(!!columnId);
  return useQuery<TaskLaunchPreview | null>({
    queryKey: [
      "tasks",
      projectId,
      "launch-preview",
      columnId,
      templateId,
      refreshKey,
      templates.map((t) => [t.id, t.updatedAt]),
    ],
    queryFn: () =>
      api(
        `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/launch-preview`,
        {
          method: "POST",
          body: JSON.stringify({ columnId, templateId }),
        }
      ),
    enabled: !!columnId,
    staleTime: 0,
  });
}

export function TaskLaunchPreviewView({
  preview,
}: {
  preview: TaskLaunchPreview;
}) {
  const config = preview.configuration;
  return (
    <div
      className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground"
      data-testid="task-launch-preview"
      aria-live="polite"
    >
      <p className="font-medium text-foreground">
        {preview.source === "task" ? "Task override" : "Column default"} ·{" "}
        {preview.templateName ?? preview.templateId}
      </p>
      {!preview.available && (
        <p role="alert" className="text-destructive">
          Unavailable: {preview.error} Choose another template or use the column
          default.
        </p>
      )}
      {config && (
        <>
          <p>
            {config.persona ? `Persona: ${config.persona} · ` : ""}
            {config.agentType} · {config.model ?? "CLI default"}
          </p>
          <p className="break-all">Workspace: {config.directory}</p>
          <p>
            {config.fullAccess ? "Full access" : "Restricted access"} ·{" "}
            {config.useWorktree ? "Separate worktree" : "Project workspace"}
            {config.baseBranch ? ` · Base: ${config.baseBranch}` : ""}
            {config.useWorktree
              ? ` · New branch: ${config.branchName ?? "generated at launch"}`
              : ""}
          </p>
        </>
      )}
    </div>
  );
}

/** Stage selection stays in this feature subtree; one operation changes one stable column ID. */
export function TaskLaunchTemplatePicker({
  projectId,
  columns,
  columnId,
  bindings = {},
  value,
  onChange,
  disabled = false,
}: {
  projectId: string;
  columns: TaskColumn[];
  columnId: string;
  bindings?: Record<string, string>;
  value?: TaskLaunchTemplateOperation;
  onChange: (value: TaskLaunchTemplateOperation | undefined) => void;
  disabled?: boolean;
}) {
  const stages = columns.filter((c) => c.trigger);
  const position = columns.find((c) => c.id === columnId)?.position ?? -1;
  const [chosenStage, setChosenStage] = useState("");
  const stage =
    stages.find((c) => c.id === value?.columnId) ??
    stages.find((c) => c.id === chosenStage) ??
    stages.find((c) => c.id === columnId) ??
    stages.find((c) => c.position >= position) ??
    stages[0];
  const templateId =
    value && value.columnId === stage?.id
      ? value.templateId
      : (bindings[stage?.id ?? ""] ?? null);
  const { data: templates = [] } = useTemplates(stages.length > 0);
  const { data: projects = [] } = useProjects();
  const root = projects.find((p) => p.id === projectId)?.repoRoot;
  const choices = templates.filter(
    (t) =>
      t.projectId === projectId ||
      (t.projectId === null && t.directory === root)
  );
  const preview = useTaskLaunchPreview(projectId, stage?.id ?? "", templateId);
  if (!stage) return null;
  return (
    <div className="space-y-2" data-testid="task-launch-template-picker">
      <label className="block text-xs font-medium text-muted-foreground">
        Launch stage
        <Select
          value={stage.id}
          disabled={disabled}
          onValueChange={(id) => {
            setChosenStage(id);
            onChange(undefined);
          }}
        >
          <SelectTrigger aria-label="Launch stage" className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {stages.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="block text-xs font-medium text-muted-foreground">
        Launch template
        <Select
          value={templateId ?? "__inherit__"}
          disabled={disabled}
          onValueChange={(id) =>
            onChange({
              columnId: stage.id,
              templateId: id === "__inherit__" ? null : id,
            })
          }
        >
          <SelectTrigger aria-label="Launch template" className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__inherit__">Use column default</SelectItem>
            {templateId && !choices.some((t) => t.id === templateId) && (
              <SelectItem value={templateId}>Unavailable template</SelectItem>
            )}
            {choices.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <p className="text-xs text-muted-foreground">
        Applies on the next eligible entry into {stage.name}. Editing this
        choice launches nothing.
      </p>
      {preview.isFetching ? (
        <p className="text-xs text-muted-foreground" role="status">
          Loading launch preview…
        </p>
      ) : preview.data ? (
        <TaskLaunchPreviewView preview={preview.data} />
      ) : null}
      {preview.error && (
        <p role="alert" className="text-xs text-destructive">
          Could not load launch preview.
        </p>
      )}
    </div>
  );
}

export function TaskLaunchTemplateEditor({
  task,
  columns,
}: {
  task: Task;
  columns: TaskColumn[];
}) {
  const [draft, setDraft] = useState<TaskLaunchTemplateOperation>();
  const [error, setError] = useState<string>();
  const actions = useTaskActions(task.projectId);
  return (
    <div className="space-y-2">
      <TaskLaunchTemplatePicker
        projectId={task.projectId}
        columns={columns}
        columnId={task.columnId}
        bindings={task.launchTemplates}
        value={draft}
        onChange={setDraft}
        disabled={actions.update.isPending}
      />
      {draft && (
        <Button
          size="sm"
          disabled={actions.update.isPending}
          onClick={() => {
            setError(undefined);
            void actions.update
              .mutateAsync({ id: task.id, launchTemplate: draft })
              .then(() => setDraft(undefined))
              .catch((err: Error) => setError(err.message));
          }}
        >
          Save launch template
        </Button>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
