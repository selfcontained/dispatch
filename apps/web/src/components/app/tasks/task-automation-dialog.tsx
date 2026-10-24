import { useEffect, useState } from "react";
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
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentTypeSelect } from "@/components/app/agent-type-select";
import { AgentModelSelect } from "@/components/app/agent-model-select";
import { useAgentModelCatalog } from "@/hooks/use-agent-model-catalog";
import { useTemplates } from "@/hooks/use-templates";
import type { TaskColumn, TaskColumnTrigger } from "@/hooks/use-tasks";
import { useTaskActions } from "@/hooks/use-tasks";
import type { AgentType } from "@/lib/agent-types";
const empty = {
  templateId: "",
  agentType: null,
  model: null,
  assign: true,
  passContext: true,
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
  const actions = useTaskActions(projectId);
  const [trigger, setTrigger] = useState<TaskColumnTrigger>(
    column.trigger ?? empty
  );
  useEffect(() => setTrigger(column.trigger ?? empty), [column]);
  const projectTemplates = templates.filter(
    (template) => template.projectId === projectId
  );
  const chosen = projectTemplates.find(
    (template) => template.id === trigger.templateId
  );
  const agentType = (trigger.agentType ??
    chosen?.agentType ??
    "claude") as AgentType;
  const models = useAgentModelCatalog(agentType);
  const toggle = (key: "assign" | "passContext" | "fireOnCreate") =>
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
          <DialogTitle>Automation · {column.name}</DialogTitle>
          <DialogDescription>
            Launch a template when a task enters this column.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 min-h-0 space-y-4 overflow-y-auto px-1 pb-1">
          <div className="space-y-1">
            <label className="text-sm" htmlFor="task-trigger-template">
              Template
            </label>
            <Select
              value={trigger.templateId || "none"}
              onValueChange={(value) =>
                setTrigger((old) => ({
                  ...old,
                  templateId: value === "none" ? "" : value,
                }))
              }
            >
              <SelectTrigger id="task-trigger-template">
                <SelectValue placeholder="Choose a template" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {projectTemplates.map((template) => (
                  <SelectItem key={template.id} value={template.id}>
                    {template.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <AgentTypeSelect
            id="task-trigger-runtime"
            value={agentType}
            onChange={(value) =>
              setTrigger((old) => ({ ...old, agentType: value }))
            }
            agentTypes={["claude", "codex", "opencode"]}
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
              ["passContext", "Pass task as context"],
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
    </Dialog>
  );
}
