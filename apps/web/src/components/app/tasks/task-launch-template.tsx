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
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";

/** One task preference applies wherever column automation launches a template. */
export function TaskLaunchTemplatePicker({
  projectId,
  value,
  onChange,
  disabled = false,
  showLabel = true,
}: {
  projectId: string;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  showLabel?: boolean;
}) {
  const templateId = value;
  const {
    data: templates = [],
    isSuccess: templatesLoaded,
    isError: templatesFailed,
    refetch,
  } = useTemplates();
  const { data: projects = [], isSuccess: projectsLoaded } = useProjects();
  const root = projects.find((p) => p.id === projectId)?.repoRoot;
  const choices = templates.filter(
    (t) =>
      t.projectId === projectId ||
      (t.projectId === null && t.directory === root)
  );
  const unavailable =
    templatesLoaded &&
    projectsLoaded &&
    !!templateId &&
    !choices.some((t) => t.id === templateId);
  return (
    <div data-testid="task-launch-template-picker">
      <Field
        label="Launch template"
        labelHidden={!showLabel}
        error={
          templatesFailed && !templatesLoaded ? (
            <>
              Couldn’t load templates.{" "}
              <Button
                type="button"
                variant="link"
                size="inline"
                onClick={() => void refetch()}
              >
                Retry
              </Button>
            </>
          ) : unavailable ? (
            "Template unavailable. Choose another template or use the column default."
          ) : null
        }
      >
        <Select
          value={templateId ?? "__inherit__"}
          disabled={disabled}
          onValueChange={(id) => onChange(id === "__inherit__" ? null : id)}
        >
          <SelectTrigger aria-label="Launch template">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__inherit__">Use column default</SelectItem>
            {unavailable && templateId && (
              <SelectItem value={templateId}>Unavailable template</SelectItem>
            )}
            {choices.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

export function TaskLaunchTemplateEditor({ task }: { task: Task }) {
  const [draft, setDraft] = useState<string | null>();
  const [error, setError] = useState<unknown>();
  const actions = useTaskActions(task.projectId);
  return (
    <div className="space-y-2">
      <TaskLaunchTemplatePicker
        projectId={task.projectId}
        showLabel={false}
        value={draft === undefined ? task.launchTemplateId : draft}
        onChange={setDraft}
        disabled={actions.update.isPending}
      />
      {draft !== undefined && (
        <Button
          size="sm"
          pending={actions.update.isPending}
          onClick={() => {
            setError(undefined);
            void actions.update
              .mutateAsync({ id: task.id, launchTemplateId: draft })
              .then(() => setDraft(undefined))
              .catch(setError);
          }}
        >
          Save launch template
        </Button>
      )}
      {error ? (
        <Alert title="Couldn’t save the launch template." error={error} />
      ) : null}
    </div>
  );
}
