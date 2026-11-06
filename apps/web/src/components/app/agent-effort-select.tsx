import type { Effort } from "@dispatch/shared";
import type { AgentType } from "@/lib/agent-types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function AgentEffortSelect({
  value,
  onChange,
  agentType,
  id = "create-agent-effort",
  inheritLabel = "Default",
}: {
  value: Effort | null;
  onChange: (value: Effort | null) => void;
  agentType: AgentType;
  id?: string;
  inheritLabel?: string;
}): JSX.Element {
  const levels: Effort[] =
    agentType === "claude"
      ? ["low", "medium", "high", "xhigh", "max"]
      : ["low", "medium", "high", "xhigh"];
  const unsupported = agentType === "opencode";
  return (
    <div className="space-y-1">
      <label className="text-sm text-muted-foreground" htmlFor={id}>
        Effort
      </label>
      <Select
        value={value ?? "inherit"}
        onValueChange={(next) => {
          if (next) onChange(next === "inherit" ? null : (next as Effort));
        }}
      >
        <SelectTrigger
          id={id}
          data-testid={id}
          disabled={unsupported}
          title={
            unsupported
              ? "OpenCode does not support launch effort."
              : "Reasoning effort"
          }
        >
          <SelectValue placeholder={unsupported ? "—" : inheritLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">
            {unsupported ? "—" : inheritLabel}
          </SelectItem>
          {levels.map((level) => (
            <SelectItem key={level} value={level}>
              {level}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
