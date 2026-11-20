import { AgentConfigRow } from "./agent-config-row";
import type { Effort } from "@dispatch/shared";
import { AgentEffortSelect } from "./agent-effort-select";
import { useMemo } from "react";

import { AgentModelSelect } from "@/components/app/agent-model-select";
import { AgentTypeSelect } from "@/components/app/agent-type-select";
import { type AgentModelOption } from "@/hooks/use-agent-model-catalog";
import { useEngines } from "@/hooks/use-engines";
import { type AgentType } from "@/lib/agent-types";

type AgentEngineFieldsProps = {
  agentType: AgentType;
  onAgentTypeChange: (type: AgentType) => void;
  agentTypes: AgentType[];
  agentLabel?: string;
  agentLoading?: boolean;
  effort?: Effort | null;
  effortDefaultLabel?: string;
  onEffortChange?: (effort: Effort | null) => void;
  model: string | null;
  onModelChange: (model: string | null) => void;
  modelOptions: readonly AgentModelOption[];
  catalogDefault?: string | null;
  modelLoading: boolean;
  onTypeOpenChange?: (open: boolean) => void;
  /** Overridden by dialogs other than Create Agent so ids stay unique. */
  idPrefix?: string;
  /** Runs on a remote runner: this machine's CLI install state is irrelevant. */
  remote?: boolean;
  statusLine?: string;
  workloadEffort?: import("@dispatch/shared").AgentConfigChoice[];
};

/**
 * The type and model pickers side by side, with the engine Dispatch will
 * drive named underneath. Every dialog that launches an agent shows them the
 * same way. Create Agent keeps the model picker visible without a catalog.
 */
export function AgentEngineFields({
  agentType,
  onAgentTypeChange,
  agentTypes,
  agentLabel,
  agentLoading,
  model,
  effort,
  effortDefaultLabel,
  onEffortChange,
  onModelChange,
  modelOptions,
  modelLoading,
  catalogDefault,
  onTypeOpenChange,
  idPrefix,
  remote = false,
  statusLine,
  workloadEffort,
}: AgentEngineFieldsProps): JSX.Element {
  // Engines whose CLI this machine does not have: pickable, but the picker
  // says what to install rather than letting the launch fail.
  const { engines } = useEngines(!remote);
  const missingEngines = useMemo(
    () =>
      Object.fromEntries(
        engines
          .filter((engine) => !engine.installed)
          .map((engine) => [
            engine.id,
            { label: engine.label, install: engine.install },
          ])
      ),
    [engines]
  );
  const showModelSelect =
    catalogDefault !== undefined || modelLoading || modelOptions.length > 0;

  return (
    <div className="space-y-3">
      <AgentConfigRow
        showModel={showModelSelect}
        showEffort={Boolean(onEffortChange)}
      >
        <AgentTypeSelect
          id={idPrefix ? `${idPrefix}-type` : undefined}
          value={agentType}
          onChange={onAgentTypeChange}
          agentTypes={agentTypes}
          label={agentLabel}
          loading={agentLoading}
          onOpenChange={onTypeOpenChange}
          missing={remote ? undefined : missingEngines}
        />

        {showModelSelect ? (
          <AgentModelSelect
            id={idPrefix ? `${idPrefix}-model` : undefined}
            testId={idPrefix ? `${idPrefix}-model` : undefined}
            value={model}
            options={modelOptions}
            catalogDefault={catalogDefault}
            onChange={onModelChange}
            loading={modelLoading}
          />
        ) : null}
        {onEffortChange ? (
          <AgentEffortSelect
            model={model}
            workload={remote}
            workloadChoices={workloadEffort}
            inheritLabel={effortDefaultLabel}
            value={effort ?? null}
            onChange={onEffortChange}
            agentType={agentType}
            id={idPrefix ? `${idPrefix}-effort` : undefined}
          />
        ) : null}
      </AgentConfigRow>
      {statusLine ? (
        <p
          className="-mt-1 truncate text-xs text-muted-foreground/70"
          title={statusLine}
          data-testid={idPrefix ? `${idPrefix}-engine` : "create-agent-engine"}
        >
          {statusLine}
        </p>
      ) : null}
    </div>
  );
}
