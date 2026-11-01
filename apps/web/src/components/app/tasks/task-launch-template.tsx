import { useState } from "react";
import { useTemplates } from "@/hooks/use-templates";
import { useProjects } from "@/hooks/use-projects";
import { useTaskActions, type Task } from "@/hooks/use-tasks";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** One task preference applies wherever column automation launches a template. */
export function TaskLaunchTemplatePicker({
  projectId,
  value,
  onChange,
  disabled = false,
}: {
  projectId: string;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const templateId = value;
  const { data: templates = [], isSuccess: templatesLoaded } = useTemplates();
  const { data: projects = [], isSuccess: projectsLoaded } = useProjects();
  const root = projects.find((p) => p.id === projectId)?.repoRoot;
  const choices = templates.filter(
    (t) =>
      t.projectId === projectId ||
      (t.projectId === null && t.directory === root)
  );
  return (
    <div className="space-y-2" data-testid="task-launch-template-picker">
      <label className="block text-xs font-medium text-muted-foreground">
        Launch template
        <Select
          value={templateId ?? "__inherit__"}
          disabled={disabled}
          onValueChange={(id) => onChange(id === "__inherit__" ? null : id)}
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

export function TaskLaunchTemplateEditor({ task }: { task: Task }) {
  const [draft, setDraft] = useState<string | null>();
  const [error, setError] = useState<string>();
  const actions = useTaskActions(task.projectId);
  return (
    <div className="space-y-2">
      <TaskLaunchTemplatePicker
        projectId={task.projectId}
        value={draft === undefined ? task.launchTemplateId : draft}
        onChange={setDraft}
        disabled={actions.update.isPending}
      />
      {draft !== undefined && (
        <Button
          size="sm"
          disabled={actions.update.isPending}
          onClick={() => {
            setError(undefined);
            void actions.update
              .mutateAsync({ id: task.id, launchTemplateId: draft })
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
