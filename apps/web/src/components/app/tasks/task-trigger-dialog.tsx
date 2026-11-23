import { effortCompatibilityError } from "@/lib/agent-effort";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Plus, Settings2, Zap } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RowButton } from "@/components/ui/row-button";
import { Hint } from "@/components/ui/tooltip";
import { AgentEngineFields } from "@/components/app/agent-engine-fields";
import { CreateTemplateDialog } from "@/components/app/automations-create-dialog";
import { useDashboardContext } from "@/components/app/dashboard-context";
import {
  useAgentModelCatalog,
  useAgentEffortCatalog,
} from "@/hooks/use-agent-model-catalog";
import { useProjects } from "@/hooks/use-projects";
import { useTemplates } from "@/hooks/use-templates";
import type { TaskColumn, TaskColumnTrigger } from "@/hooks/use-tasks";
import { useTaskActions } from "@/hooks/use-tasks";
import type { AgentType } from "@/lib/agent-types";
import { templateName } from "./task-utils";
import { Alert } from "@/components/ui/alert";
import { Field, FieldError } from "@/components/ui/field";
import { OptionCard } from "@/components/ui/setting-row";
const NEW_TEMPLATE = "__new_template__";

/**
 * The column's trigger, written out as the rule it is and sitting
 * under the column header where a task would cross into it. Click to
 * edit. Nothing renders for a column without one; the menu adds it.
 */
export function ColumnTriggerStrip({
  column,
  projectId,
  className,
}: {
  column: TaskColumn;
  projectId: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const strip = useRef<HTMLButtonElement>(null);
  const { data: templates } = useTemplates();
  if (!column.trigger) return null;
  const name = templateName(templates, column.trigger.templateId);
  return (
    <>
      <Hint label="Edit trigger">
        <RowButton
          ref={strip}
          data-testid={`task-column-trigger-${column.key}`}
          onClick={() => setOpen(true)}
          className={cn(
            "rounded-none border-b border-[hsl(var(--col)/0.25)] bg-[hsl(var(--col)/0.06)] px-3 py-1.5 text-body-sm hover:bg-[hsl(var(--col)/0.14)]",
            className
          )}
        >
          <Zap
            className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--col))]"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate whitespace-nowrap text-muted-foreground">
            On entry → launches{" "}
            <span className="font-medium text-foreground">{name}</span>
          </span>
          <Settings2
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </RowButton>
      </Hint>
      <TaskTriggerDialog
        column={column}
        projectId={projectId}
        open={open}
        onOpenChange={setOpen}
        returnFocus={strip}
      />
    </>
  );
}
const empty = {
  templateId: "",
  agentType: null,
  model: null,
  effort: null,
  assign: true,
  fireOnCreate: false,
} satisfies TaskColumnTrigger;
export function TaskTriggerDialog({
  column,
  projectId,
  open,
  onOpenChange,
  returnFocus,
}: {
  column: TaskColumn;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opened without a DialogTrigger, so closing has nowhere to go but this. */
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const { data: templates = [] } = useTemplates(open);
  const { data: projects = [] } = useProjects();
  const project = projects.find((p) => p.id === projectId) ?? {
    id: projectId,
    repoRoot: "",
  };
  const [creating, setCreating] = useState(false);
  // Opening the create dialog from the menu; the Select must not pull focus
  // back to its trigger over the new dialog's name field.
  const openingCreate = useRef(false);
  const templateTrigger = useRef<HTMLButtonElement>(null);
  const actions = useTaskActions(projectId);
  const { enabledAgentTypes } = useDashboardContext();
  const [pending, setPending] = useState<"save" | "remove">();
  const [failure, setFailure] = useState<unknown>();
  const [trigger, setTrigger] = useState<TaskColumnTrigger>(
    column.trigger ?? empty
  );
  // A canceled draft must not survive reopening the same column object.
  useEffect(() => {
    if (open) setTrigger(column.trigger ?? empty);
  }, [column, open]);
  useEffect(() => {
    if (open) setFailure(undefined);
  }, [open]);
  const projectTemplates = templates.filter(
    (template) => template.projectId === projectId
  );
  const sharedName = (name: string) =>
    projectTemplates.filter((template) => template.name === name).length > 1;
  const chosen = projectTemplates.find(
    (template) => template.id === trigger.templateId
  );
  // Null keeps the template's engine; the picker shows what that resolves to.
  const templateType = (chosen?.agentType ?? "claude") as AgentType;
  const agentType = (trigger.agentType ?? templateType) as AgentType;
  const models = useAgentModelCatalog(agentType);
  const effortCatalog = useAgentEffortCatalog();
  const effortChoices = effortCatalog(
    agentType,
    trigger.model ?? (agentType === templateType ? chosen?.model : null) ?? null
  );
  const inheritsEffort =
    agentType === templateType &&
    (!trigger.model || trigger.model === chosen?.model);
  const resolvedEffort =
    trigger.effort ?? (inheritsEffort ? chosen?.effort : null) ?? null;
  const effortConflict = effortCompatibilityError(
    resolvedEffort,
    effortChoices
  );
  const selectTemplate = (templateId: string, nextTemplateType: AgentType) => {
    const nextTemplate = projectTemplates.find(
      (template) => template.id === templateId
    );
    setTrigger((old) => ({
      ...old,
      templateId,
      effort: effortCompatibilityError(
        old.effort,
        effortCatalog(
          old.agentType ?? nextTemplateType,
          old.model ?? nextTemplate?.model ?? null
        )
      )
        ? null
        : old.effort,
    }));
  };
  const toggle = (key: "assign" | "fireOnCreate") =>
    setTrigger((old) => ({ ...old, [key]: !old[key] }));
  const submit = async (
    action: "save" | "remove",
    next: TaskColumnTrigger | null
  ) => {
    setPending(action);
    setFailure(undefined);
    try {
      await actions.updateColumn.mutateAsync({ id: column.id, trigger: next });
      onOpenChange(false);
    } catch (error) {
      setFailure(error);
    } finally {
      setPending(undefined);
    }
  };
  const save = () => {
    if (effortConflict) return;
    void submit(
      "save",
      trigger.templateId
        ? { ...trigger, model: models.normalizeModel(trigger.model) }
        : null
    );
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        busy={Boolean(pending)}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {column.trigger ? "Edit" : "New"} trigger · {column.name}
          </DialogTitle>
          <DialogDescription>
            {column.trigger
              ? `This column already launches ${templateName(projectTemplates, column.trigger.templateId)} when a task enters it.`
              : "Nothing happens yet when a task enters this column. Choose a template to launch."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label="Template" id="task-trigger-template">
            <Select
              value={trigger.templateId || "none"}
              onValueChange={(value) => {
                if (value === NEW_TEMPLATE) {
                  openingCreate.current = true;
                  return setCreating(true);
                }
                selectTemplate(
                  value === "none" ? "" : value,
                  projectTemplates.find((template) => template.id === value)
                    ?.agentType ?? "claude"
                );
              }}
            >
              <SelectTrigger ref={templateTrigger}>
                <SelectValue placeholder="Choose a template" />
              </SelectTrigger>
              <SelectContent
                onCloseAutoFocus={(event) => {
                  if (!openingCreate.current) return;
                  openingCreate.current = false;
                  event.preventDefault();
                }}
              >
                <SelectItem value="none">None</SelectItem>
                {projectTemplates.map((template) => (
                  <SelectItem key={template.id} value={template.id}>
                    {template.name}
                    {sharedName(template.name) ? (
                      <span className="ml-1.5 text-body-sm text-muted-foreground">
                        {template.directory.split("/").filter(Boolean).pop()}
                      </span>
                    ) : null}
                  </SelectItem>
                ))}
                <SelectSeparator />
                <SelectItem value={NEW_TEMPLATE}>
                  <span className="flex items-center gap-1.5">
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    New template…
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <AgentEngineFields
            idPrefix="task-trigger"
            agentType={agentType}
            onAgentTypeChange={(value) =>
              setTrigger((old) => ({
                ...old,
                // Picking the template's own engine goes back to following it.
                agentType: value === templateType ? null : value,
                effort: null,
              }))
            }
            agentTypes={enabledAgentTypes}
            effortDefaultLabel={
              inheritsEffort && chosen?.effort
                ? `Inherit (${effortChoices?.find((c) => c.value === chosen.effort)?.name ?? chosen.effort})`
                : "Default"
            }
            effort={trigger.effort ?? null}
            onEffortChange={(effort) =>
              setTrigger((old) => ({ ...old, effort }))
            }
            model={trigger.model}
            onModelChange={(model) =>
              setTrigger((old) => ({ ...old, model, effort: null }))
            }
            modelOptions={models.options}
            savedOption={models.savedOption(trigger.model)}
            modelLoading={models.loading}
          />
          {effortConflict ? <FieldError>{effortConflict}</FieldError> : null}
          {(
            [
              ["assign", "Assign the launched agent"],
              ["fireOnCreate", "Also fire when created here"],
            ] as const
          ).map(([key, label]) => (
            <OptionCard key={key} label={label}>
              <Checkbox
                checked={trigger[key]}
                onCheckedChange={() => toggle(key)}
              />
            </OptionCard>
          ))}
          <p className="rounded-sm bg-surface-hover p-2 text-body-sm text-muted-foreground">
            {chosen
              ? `Entering ${column.name} launches ${chosen.name}${chosen.prompt?.trim() ? "" : " with the task as its prompt"}${trigger.assign ? " and assigns the agent" : ""}.`
              : "Choose a project template to configure this column."}
          </p>
        </DialogBody>
        {failure ? (
          <Alert title="Couldn’t save the trigger." error={failure} />
        ) : null}
        <DialogFooter
          start={
            <Button
              variant="ghost"
              disabled={!column.trigger || Boolean(pending)}
              pending={pending === "remove"}
              onClick={() => void submit("remove", null)}
            >
              Remove trigger
            </Button>
          }
        >
          <DialogCancel />
          <Button
            variant="primary"
            disabled={
              !trigger.templateId || Boolean(effortConflict) || Boolean(pending)
            }
            pending={pending === "save"}
            onClick={save}
          >
            Save trigger
          </Button>
        </DialogFooter>
      </DialogContent>
      <CreateTemplateDialog
        open={creating}
        onOpenChange={setCreating}
        enabledAgentTypes={enabledAgentTypes}
        project={project}
        onCreated={(template) =>
          selectTemplate(template.id, template.agentType)
        }
        onCloseAutoFocus={(event) => {
          // The menu item that opened it is gone; return to the picker.
          event.preventDefault();
          templateTrigger.current?.focus();
        }}
      />
    </Dialog>
  );
}
