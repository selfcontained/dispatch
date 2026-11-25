import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import {
  AgentModelSettings,
  useSettingsAgentModelCatalog,
} from "@/components/app/agent-model-settings";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { RowButton } from "@/components/ui/row-button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  CLI_AGENT_TYPES,
} from "@/lib/agent-types";
import { SettingsGroup } from "@/components/app/settings-layout";
import { panelFrame } from "@/components/ui/card";
import {
  SaveFailure,
  SavedNote,
  type SaveStatus,
} from "@/components/ui/setting-row";
import { useAutoSave } from "@/hooks/use-auto-save";
import { LoadError } from "@/components/ui/async-boundary";
import { LoadingSkeleton } from "@/components/ui/skeleton";

type AgentTypeSettingsResponse = {
  enabledAgentTypes: AgentType[];
};

const AGENT_TYPE_DESCRIPTIONS: Record<AgentType, string> = {
  claude: "Claude Code CLI by Anthropic.",
  codex: "Codex CLI by OpenAI.",
  opencode: "OpenCode CLI with your configured model providers.",
};

type AgentTypeSettingsProps = {
  enabledAgentTypes: AgentType[];
  onChange: (agentTypes: AgentType[]) => void;
};

function AgentTypeRow({
  agentType,
  checked,
  disabled,
  status,
  onToggle,
  open,
  onOpenChange,
}: {
  agentType: AgentType;
  checked: boolean;
  disabled: boolean;
  status: SaveStatus;
  onToggle: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { options, allOptions } = useSettingsAgentModelCatalog(agentType);
  const offCount = allOptions.length - options.length;
  const wasOpen = useRef(open);
  useEffect(() => {
    // New stays up while the list is open, and clears once it has been seen.
    if (wasOpen.current && !open)
      allOptions.forEach((option) => option.markSeen?.());
    wasOpen.current = open;
  }, [allOptions, open]);
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className={panelFrame}>
      <div className="flex items-stretch">
        <label
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3 px-3 py-3 transition-colors",
            disabled
              ? "cursor-not-allowed opacity-60"
              : "cursor-pointer hover:bg-surface-hover"
          )}
        >
          <Checkbox
            checked={checked}
            disabled={disabled}
            onCheckedChange={onToggle}
            data-testid={`agent-type-toggle-${agentType}`}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 text-body-md font-medium text-foreground">
              {AGENT_TYPE_LABELS[agentType]}
              <SavedNote status={status} />
            </div>
            <div className="text-body-sm text-muted-foreground">
              {disabled
                ? "At least one type must stay enabled."
                : AGENT_TYPE_DESCRIPTIONS[agentType]}
            </div>
          </div>
        </label>
        <CollapsibleTrigger asChild>
          <RowButton
            className="group min-h-11 w-auto shrink-0 justify-center gap-1.5 rounded-none px-3 text-body-sm text-muted-foreground hover:text-foreground"
            aria-label={`${AGENT_TYPE_LABELS[agentType]} models: ${options.length} on, ${offCount} off`}
            data-testid={`agent-models-toggle-${agentType}`}
          >
            {allOptions.length ? (
              <span className="flex items-baseline gap-2 text-body-md tabular-nums">
                <span className="font-semibold text-foreground">
                  {options.length}
                </span>
                {offCount ? (
                  <span className="text-muted-foreground line-through">
                    {offCount}
                  </span>
                ) : null}
              </span>
            ) : null}
            <ChevronDown className="size-icon-md transition-transform group-data-[state=open]:rotate-180" />
          </RowButton>
        </CollapsibleTrigger>
      </div>
      <SaveFailure status={status} className="mx-3 mb-3" />
      <CollapsibleContent className="border-t border-border-subtle">
        <AgentModelSettings agentType={agentType} />
      </CollapsibleContent>
    </Collapsible>
  );
}

export function AgentTypeSettings({
  enabledAgentTypes,
  onChange,
}: AgentTypeSettingsProps): JSX.Element {
  const [agentTypes, setAgentTypes] = useState<AgentType[]>(enabledAgentTypes);
  const [searchParams, setSearchParams] = useSearchParams();
  const openType =
    CLI_AGENT_TYPES.find((type) => type === searchParams.get("models")) ?? null;
  const [loading, setLoading] = useState(true);
  // What the server last confirmed, read by a save when its turn comes.
  const savedRef = useRef(enabledAgentTypes);
  const [loadError, setLoadError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setAgentTypes(enabledAgentTypes);
    savedRef.current = enabledAgentTypes;
  }, [enabledAgentTypes]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    void api<AgentTypeSettingsResponse>("/api/v1/app/settings/agent-types")
      .then((data) => {
        if (cancelled) return;
        setAgentTypes(data.enabledAgentTypes);
        savedRef.current = data.enabledAgentTypes;
        onChange(data.enabledAgentTypes);
        setLoadError(undefined);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [onChange, attempt]);

  const autoSave = useAutoSave<boolean, AgentType>(async (type, enabled) => {
    const others = savedRef.current.filter((item) => item !== type);
    const data = await api<AgentTypeSettingsResponse>(
      "/api/v1/app/settings/agent-types",
      {
        method: "POST",
        body: JSON.stringify({
          enabledAgentTypes: enabled ? [...others, type] : others,
        }),
      }
    );
    savedRef.current = data.enabledAgentTypes;
    setAgentTypes(data.enabledAgentTypes);
    onChange(data.enabledAgentTypes);
  });
  const shown = CLI_AGENT_TYPES.filter((type) =>
    autoSave.value(type, agentTypes.includes(type))
  );

  return (
    <SettingsGroup
      title="Available agent types"
      description="Choose which agent types and models Dispatch offers for new launches."
    >
      {loadError ? (
        <LoadError
          thing="agent type settings"
          error={loadError}
          retrying={loading}
          onRetry={() => setAttempt((count) => count + 1)}
        />
      ) : loading ? (
        <LoadingSkeleton
          label="Loading agent type settings…"
          rowClassName="h-16"
        />
      ) : (
        CLI_AGENT_TYPES.map((agentType) => {
          const checked = shown.includes(agentType);
          const disabled = checked && shown.length === 1;
          return (
            <AgentTypeRow
              key={agentType}
              agentType={agentType}
              checked={checked}
              disabled={disabled}
              status={autoSave.status(agentType)}
              onToggle={() => void autoSave.save(agentType, !checked)}
              open={openType === agentType}
              onOpenChange={(open) =>
                setSearchParams(
                  (params) => {
                    const next = new URLSearchParams(params);
                    if (open) next.set("models", agentType);
                    else next.delete("models");
                    return next;
                  },
                  { replace: true }
                )
              }
            />
          );
        })
      )}
    </SettingsGroup>
  );
}
