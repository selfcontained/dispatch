import { useMemo } from "react";

import { Field } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  sortAgentTypes,
} from "@/lib/agent-types";

type AgentTypeSelectProps = {
  value: AgentType;
  onChange: (type: AgentType) => void;
  agentTypes: AgentType[];
  label?: string;
  /** Override when a page can render more than one of these, so ids stay
   * unique. */
  id?: string;
  testId?: string;
  /**
   * Engines whose CLI this machine does not have. They stay pickable (so a
   * person can see what Dispatch supports) but say what to install.
   */
  missing?: Readonly<Record<string, { label: string; install: string }>>;
};

export function AgentTypeSelect({
  value,
  onChange,
  agentTypes,
  label = "Type",
  id = "agent-type-select",
  testId,
  missing,
}: AgentTypeSelectProps): JSX.Element {
  const sortedTypes = useMemo(() => sortAgentTypes(agentTypes), [agentTypes]);

  return (
    <Field
      id={id}
      label={label}
      hint={
        missing?.[value] ? (
          <span
            className="text-warning-ink"
            data-testid="agent-type-missing-note"
          >
            {missing[value]!.label} is not installed. Run{" "}
            <code className="font-mono">{missing[value]!.install}</code> and
            sign in.
          </span>
        ) : null
      }
    >
      <Select
        value={value}
        onValueChange={(next) => {
          // Radix's hidden form input can echo an empty value.
          if (next) onChange(next as AgentType);
        }}
      >
        <SelectTrigger data-testid={testId}>
          <SelectValue>{AGENT_TYPE_LABELS[value]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {sortedTypes.map((agentType) => (
            <SelectItem
              key={agentType}
              value={agentType}
              textValue={AGENT_TYPE_LABELS[agentType]}
            >
              {AGENT_TYPE_LABELS[agentType]}
              {missing?.[agentType] ? (
                <span
                  className="ml-2 text-label-sm text-muted-foreground"
                  data-testid="agent-type-missing"
                >
                  not installed
                </span>
              ) : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
