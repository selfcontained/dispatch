import { useRef } from "react";
import { Plus } from "lucide-react";
import type { Agent } from "@/components/app/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { TaskAgentChip } from "./task-agent";
import { assigneeOptions } from "./task-utils";

const UNASSIGNED = "__unassigned";
const NEW_AGENT = "__new_agent";

/**
 * The project's agents, running first, plus Unassigned — and, when the
 * caller can launch one, "New agent…" at the top, so assigning a task to
 * an agent that does not exist yet is the same gesture as picking one.
 */
export function AssigneeSelect({
  value,
  agents,
  projectId,
  onChange,
  onNew,
  className,
}: {
  value: string | null;
  agents: Agent[];
  projectId: string;
  onChange: (agentId: string | null) => void;
  /** Opens the launch flow; the launched agent becomes the assignee. */
  onNew?: () => void;
  className?: string;
}) {
  const options = assigneeOptions(agents, projectId, value);
  // Choosing "New agent…" opens a dialog; the Select must not pull focus
  // back to its trigger over the dialog's first field.
  const openingNew = useRef(false);
  return (
    <Select
      value={value ?? UNASSIGNED}
      onValueChange={(next) => {
        if (next === NEW_AGENT) {
          openingNew.current = true;
          onNew?.();
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
          if (!openingNew.current) return;
          openingNew.current = false;
          event.preventDefault();
        }}
      >
        {onNew && (
          <>
            <SelectItem value={NEW_AGENT} data-testid="assignee-new-agent">
              <span className="flex items-center gap-1.5">
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                New agent…
              </span>
            </SelectItem>
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
