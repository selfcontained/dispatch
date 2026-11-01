import { useState } from "react";
import { useTemplates } from "@/hooks/use-templates";
import { useProjects } from "@/hooks/use-projects";
import { useTaskActions, type Task, type TaskColumn } from "@/hooks/use-tasks";
import type { TaskLaunchTemplateOperation } from "../../../../../server/src/tasks/types";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
  const { data: templates = [], isSuccess: templatesLoaded } = useTemplates(
    stages.length > 0
  );
  const { data: projects = [], isSuccess: projectsLoaded } = useProjects();
  const root = projects.find((p) => p.id === projectId)?.repoRoot;
  const choices = templates.filter(
    (t) =>
      t.projectId === projectId ||
      (t.projectId === null && t.directory === root)
  );
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
            {templatesLoaded &&
              projectsLoaded &&
              templateId &&
              !choices.some((t) => t.id === templateId) && (
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
      {templatesLoaded &&
        projectsLoaded &&
        templateId &&
        !choices.some((t) => t.id === templateId) && (
          <p role="alert" className="text-xs text-destructive">
            Template unavailable. Choose another template or use the column
            default.
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
