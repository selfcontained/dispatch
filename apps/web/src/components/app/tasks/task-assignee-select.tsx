import type { Agent } from "@/components/app/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { TaskAgentChip } from "./task-agent";
import { assigneeOptions } from "./task-utils";

const UNASSIGNED = "__unassigned";

/** The project's agents, running first, plus Unassigned. */
export function AssigneeSelect({
  value,
  agents,
  projectId,
  onChange,
  className,
}: {
  value: string | null;
  agents: Agent[];
  projectId: string;
  onChange: (agentId: string | null) => void;
  className?: string;
}) {
  const options = assigneeOptions(agents, projectId, value);
  return (
    <Select
      value={value ?? UNASSIGNED}
      onValueChange={(next) => onChange(next === UNASSIGNED ? null : next)}
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
      <SelectContent>
        <SelectItem value={UNASSIGNED}>
          <span className="text-muted-foreground">Unassigned</span>
        </SelectItem>
        {options.map((agent) => (
          <SelectItem key={agent.id} value={agent.id}>
            <TaskAgentChip agent={agent} compact />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
