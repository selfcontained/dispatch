import { useEffect, useRef, useState } from "react";
import { Plus, Settings2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { AgentTypeSelect } from "@/components/app/agent-type-select";
import { AgentModelSelect } from "@/components/app/agent-model-select";
import { CreateTemplateDialog } from "@/components/app/automations-create-dialog";
import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import { useProjects } from "@/hooks/use-projects";
import { useTemplates } from "@/hooks/use-templates";
import type { TaskColumn, TaskColumnTrigger } from "@/hooks/use-tasks";
import { useTaskActions } from "@/hooks/use-tasks";
import type { AgentType } from "@/lib/agent-types";
import { templateName } from "./task-utils";
const NEW_TEMPLATE = "__new_template__";

/**
 * The column's automation, written out as the rule it is and sitting
 * under the column header where a task would cross into it. Click to
 * edit. Nothing renders for a column without one; the menu adds it.
 */
export function ColumnAutomationStrip({
  column,
  projectId,
  className,
}: {
  column: TaskColumn;
  projectId: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { data: templates } = useTemplates();
  if (!column.trigger) return null;
  const name = templateName(templates, column.trigger.templateId);
  return (
    <>
      <button
        type="button"
        data-testid={`task-column-automation-${column.key}`}
        onClick={() => setOpen(true)}
        title="Edit automation"
        className={cn(
          "flex w-full items-center gap-2 border-b border-[hsl(var(--col)/0.25)] bg-[hsl(var(--col)/0.06)] px-3 py-1.5 text-left text-xs transition-colors hover:bg-[hsl(var(--col)/0.14)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
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
      </button>
      <TaskAutomationDialog
        column={column}
        projectId={projectId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
const runtimes: AgentType[] = ["claude", "codex", "opencode"];
const empty = {
  templateId: "",
  agentType: null,
  model: null,
  assign: true,
  fireOnCreate: false,
} satisfies TaskColumnTrigger;
export function TaskAutomationDialog({
  column,
  projectId,
  open,
  onOpenChange,
}: {
  column: TaskColumn;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  const [trigger, setTrigger] = useState<TaskColumnTrigger>(
    column.trigger ?? empty
  );
  useEffect(() => setTrigger(column.trigger ?? empty), [column]);
  const projectTemplates = templates.filter(
    (template) => template.projectId === projectId
  );
  const sharedName = (name: string) =>
    projectTemplates.filter((template) => template.name === name).length > 1;
  const chosen = projectTemplates.find(
    (template) => template.id === trigger.templateId
  );
  const agentType = (trigger.agentType ??
    chosen?.agentType ??
    "claude") as AgentType;
  const models = useAgentModelCatalog(agentType);
  const toggle = (key: "assign" | "fireOnCreate") =>
    setTrigger((old) => ({ ...old, [key]: !old[key] }));
  const save = async () => {
    await actions.updateColumn.mutateAsync({
      id: column.id,
      trigger: trigger.templateId
        ? { ...trigger, model: models.normalizeModel(trigger.model) }
        : null,
    });
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {column.trigger ? "Edit automation" : "Add automation"} ·{" "}
            {column.name}
          </DialogTitle>
          <DialogDescription>
            {column.trigger
              ? `This column already launches ${templateName(projectTemplates, column.trigger.templateId)} when a task enters it.`
              : "Nothing happens yet when a task enters this column. Choose a template to launch."}
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 min-h-0 space-y-4 overflow-y-auto px-1 pb-1">
          <div className="space-y-1">
            <label className="text-sm" htmlFor="task-trigger-template">
              Template
            </label>
            <Select
              value={trigger.templateId || "none"}
              onValueChange={(value) => {
                if (value === NEW_TEMPLATE) {
                  openingCreate.current = true;
                  return setCreating(true);
                }
                setTrigger((old) => ({
                  ...old,
                  templateId: value === "none" ? "" : value,
                }));
              }}
            >
              <SelectTrigger id="task-trigger-template" ref={templateTrigger}>
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
                      <span className="ml-1.5 text-xs text-muted-foreground">
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
          </div>
          <AgentTypeSelect
            id="task-trigger-runtime"
            value={agentType}
            onChange={(value) =>
              setTrigger((old) => ({ ...old, agentType: value }))
            }
            agentTypes={runtimes}
            label="Runtime"
          />
          <AgentModelSelect
            id="task-trigger-model"
            testId="task-trigger-model"
            value={trigger.model}
            options={models.options}
            onChange={(model) => setTrigger((old) => ({ ...old, model }))}
            loading={models.loading}
          />
          {(
            [
              ["assign", "Assign the launched agent"],
              ["fireOnCreate", "Also fire when created here"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={trigger[key]}
                onCheckedChange={() => toggle(key)}
              />
              {label}
            </label>
          ))}
          <p className="rounded bg-muted/50 p-2 text-xs text-muted-foreground">
            {chosen
              ? `Entering ${column.name} launches ${chosen.name}${trigger.assign ? " and assigns the agent" : ""}.`
              : "Choose a project template to configure this column."}
          </p>
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              variant="ghost"
              disabled={!column.trigger}
              onClick={() => {
                void actions.updateColumn
                  .mutateAsync({ id: column.id, trigger: null })
                  .then(() => onOpenChange(false));
              }}
            >
              Remove automation
            </Button>
            <Button
              disabled={!trigger.templateId || actions.updateColumn.isPending}
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
      <CreateTemplateDialog
        open={creating}
        onOpenChange={setCreating}
        enabledAgentTypes={runtimes}
        project={project}
        onCreated={(template) =>
          setTrigger((old) => ({ ...old, templateId: template.id }))
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
