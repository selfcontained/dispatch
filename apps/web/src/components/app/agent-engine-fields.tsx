import { AgentConfigRow } from "./agent-config-row";
import type { Effort } from "@dispatch/shared";
import { AgentEffortSelect } from "./agent-effort-select";
import { useMemo } from "react";

import { AgentModelSelect } from "@/components/app/agent-model-select";
import { AgentTypeSelect } from "@/components/app/agent-type-select";
import { type AgentModelOption } from "@/hooks/use-agent-model-catalog";
import {
  engineSummary,
  useEngines,
  type EngineStatus,
} from "@/hooks/use-engines";
import { type AgentType } from "@/lib/agent-types";

type AgentEngineFieldsProps = {
  agentType: AgentType;
  onAgentTypeChange: (type: AgentType) => void;
  agentTypes: AgentType[];
  target?: {
    engines: EngineStatus[] | null;
    effort?: import("@dispatch/shared").AgentConfigChoice[];
  };
  effort?: Effort | null;
  effortDefaultLabel?: string;
  onEffortChange?: (effort: Effort | null) => void;
  model: string | null;
  onModelChange: (model: string | null) => void;
  modelOptions: readonly AgentModelOption[];
  /** Pass null to show the engine setting when there is no known default. */
  catalogDefault?: string | null;
  /** What is saved now, which may have been turned off since. */
  savedOption?: AgentModelOption | null;
  modelLoading: boolean;
  /** Overridden by dialogs other than Create Agent so ids stay unique. */
  idPrefix?: string;
};

const EMPTY_ENGINES: EngineStatus[] = [];

/**
 * The type and model pickers side by side, with the engine Dispatch will
 * drive named underneath. Every dialog that launches an agent shows them the
 * same way. Create Agent also shows the fallback when a catalog is missing.
 */
export function AgentEngineFields({
  agentType,
  onAgentTypeChange,
  agentTypes,
  target,
  model,
  effort,
  effortDefaultLabel,
  onEffortChange,
  onModelChange,
  modelOptions,
  catalogDefault,
  savedOption,
  modelLoading,
  idPrefix,
}: AgentEngineFieldsProps): JSX.Element {
  // Engines whose CLI this machine does not have: pickable, but the picker
  // says what to install rather than letting the launch fail.
  const native = useEngines(target === undefined);
  const engines = target ? (target.engines ?? EMPTY_ENGINES) : native.engines;
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
  const engineLine = engineSummary(engines, agentType);
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
          missing={missingEngines}
        />

        {showModelSelect ? (
          <AgentModelSelect
            id={idPrefix ? `${idPrefix}-model` : undefined}
            testId={idPrefix ? `${idPrefix}-model` : undefined}
            value={model}
            options={modelOptions}
            catalogDefault={catalogDefault}
            savedOption={savedOption}
            onChange={onModelChange}
            loading={modelLoading}
          />
        ) : null}
        {onEffortChange ? (
          <AgentEffortSelect
            model={model}
            workload={target !== undefined}
            workloadChoices={target?.effort}
            inheritLabel={effortDefaultLabel}
            value={effort ?? null}
            onChange={onEffortChange}
            agentType={agentType}
            id={idPrefix ? `${idPrefix}-effort` : undefined}
          />
        ) : null}
      </AgentConfigRow>
      {engineLine ? (
        <p
          className="-mt-1 truncate text-body-sm text-faint"
          title={engineLine}
          data-testid={idPrefix ? `${idPrefix}-engine` : "create-agent-engine"}
        >
          {engineLine}
        </p>
      ) : null}
    </div>
  );
}
