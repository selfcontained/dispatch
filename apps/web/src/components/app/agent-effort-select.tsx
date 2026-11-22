import type { Effort } from "@dispatch/shared";
import type { AgentType } from "@/lib/agent-types";
import { useAgentEffortChoices } from "@/hooks/use-agent-model-catalog";
import { EffortPicker } from "./effort-picker";
import { Field } from "@/components/ui/field";

export function AgentEffortSelect({
  value,
  onChange,
  agentType,
  model = null,
  id = "create-agent-effort",
  inheritLabel = "Default",
}: {
  value: Effort | null;
  onChange: (value: Effort | null) => void;
  agentType: AgentType;
  model?: string | null;
  id?: string;
  inheritLabel?: string;
}): JSX.Element {
  const choices = useAgentEffortChoices(agentType, model);
  return (
    <Field id={id} label="Effort">
      <EffortPicker
        id={id}
        value={value}
        onChange={onChange}
        choices={choices ?? []}
        defaultLabel={inheritLabel}
        description={
          choices === undefined
            ? "Effort levels have not been reported for this model yet. Default uses the agent’s settings."
            : choices.length === 0
              ? "This model does not report adjustable effort."
              : "Default follows the saved configuration. Higher levels spend more time thinking."
        }
      />
    </Field>
  );
}
