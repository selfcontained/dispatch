import { useRef } from "react";
import { Plus, Zap } from "lucide-react";
import type { Agent } from "@/components/app/types";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { TaskAgentChip } from "./task-agent";
import { assigneeOptions } from "./task-utils";

const UNASSIGNED = "__unassigned";
const NEW_AGENT = "__new_agent";
const TEMPLATE_PREFIX = "template:";

/**
 * The project's agents, running first, plus Unassigned — and, when the
 * caller can launch one, "New agent…" and the project's templates at the
 * top, so assigning a task to an agent that does not exist yet is the
 * same gesture as picking one.
 */
export function AssigneeSelect({
  value,
  agents,
  projectId,
  onChange,
  onNew,
  templates = [],
  onLaunchTemplate,
  className,
}: {
  value: string | null;
  agents: Agent[];
  projectId: string;
  onChange: (agentId: string | null) => void;
  /** Opens the create-agent flow; the created agent becomes the assignee. */
  onNew?: () => void;
  /** The task's project's templates; each launches and assigns. */
  templates?: ReadonlyArray<{ id: string; name: string }>;
  onLaunchTemplate?: (templateId: string) => void;
  className?: string;
}) {
  const options = assigneeOptions(agents, projectId, value);
  // Choosing a launch entry opens a dialog or starts an agent; the Select
  // must not pull focus back to its trigger over whatever comes next.
  const launching = useRef(false);
  const canLaunch = Boolean(onNew || (onLaunchTemplate && templates.length));
  return (
    <Select
      value={value ?? UNASSIGNED}
      onValueChange={(next) => {
        if (next === NEW_AGENT) {
          launching.current = true;
          onNew?.();
          return;
        }
        if (next.startsWith(TEMPLATE_PREFIX)) {
          launching.current = true;
          onLaunchTemplate?.(next.slice(TEMPLATE_PREFIX.length));
          return;
        }
        onChange(next === UNASSIGNED ? null : next);
      }}
    >
      <SelectTrigger
        aria-label="Assignee"
        className={cn(
          "h-8 w-full max-w-64 border-transparent bg-muted/50 text-xs hover:bg-muted",
          className
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        onCloseAutoFocus={(event) => {
          if (!launching.current) return;
          launching.current = false;
          event.preventDefault();
        }}
      >
        {canLaunch && (
          <>
            {onNew && (
              <SelectItem value={NEW_AGENT} data-testid="assignee-new-agent">
                <span className="flex items-center gap-1.5">
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  New agent…
                </span>
              </SelectItem>
            )}
            {onLaunchTemplate && templates.length > 0 && (
              <SelectGroup>
                <SelectLabel className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Launch from template
                </SelectLabel>
                {templates.map((template) => (
                  <SelectItem
                    key={template.id}
                    value={`${TEMPLATE_PREFIX}${template.id}`}
                    data-testid={`assignee-template-${template.id}`}
                  >
                    <span className="flex items-center gap-1.5">
                      <Zap
                        className="h-3.5 w-3.5 text-muted-foreground"
                        aria-hidden="true"
                      />
                      {template.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            <SelectSeparator />
          </>
        )}
        <SelectItem value={UNASSIGNED}>
          <span className="text-muted-foreground">Unassigned</span>
        </SelectItem>
        {options.map((agent) => (
          <SelectItem key={agent.id} value={agent.id}>
            <TaskAgentChip agent={agent} agents={options} compact />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
