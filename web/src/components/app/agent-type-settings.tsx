import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { AGENT_TYPES, AGENT_TYPE_LABELS, type AgentType } from "@/lib/agent-types";

type AgentTypeSettingsResponse = {
  enabledAgentTypes: AgentType[];
};

type AgentTypeSettingsProps = {
  enabledAgentTypes: AgentType[];
  onChange: (agentTypes: AgentType[]) => void;
};

export function AgentTypeSettings({
  enabledAgentTypes,
  onChange,
}: AgentTypeSettingsProps): JSX.Element {
  const [draftAgentTypes, setDraftAgentTypes] = useState<AgentType[]>(enabledAgentTypes);
  const [savedAgentTypes, setSavedAgentTypes] = useState<AgentType[]>(enabledAgentTypes);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setDraftAgentTypes(enabledAgentTypes);
    setSavedAgentTypes(enabledAgentTypes);
  }, [enabledAgentTypes]);

  useEffect(() => {
    let cancelled = false;

    void api<AgentTypeSettingsResponse>("/api/v1/app/settings/agent-types")
      .then((data) => {
        if (cancelled) return;
        setDraftAgentTypes(data.enabledAgentTypes);
        setSavedAgentTypes(data.enabledAgentTypes);
        onChange(data.enabledAgentTypes);
        setError("");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load agent type settings.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [onChange]);

  const hasChanges =
    JSON.stringify([...draftAgentTypes].sort()) !== JSON.stringify([...savedAgentTypes].sort());

  const toggleAgentType = useCallback((agentType: AgentType) => {
    setMessage("");
    setError("");
    setDraftAgentTypes((current) => {
      if (current.includes(agentType)) {
        return current.filter((item) => item !== agentType);
      }
      return [...current, agentType];
    });
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const data = await api<AgentTypeSettingsResponse>("/api/v1/app/settings/agent-types", {
        method: "POST",
        body: JSON.stringify({ enabledAgentTypes: draftAgentTypes }),
      });
      setDraftAgentTypes(data.enabledAgentTypes);
      setSavedAgentTypes(data.enabledAgentTypes);
      onChange(data.enabledAgentTypes);
      setMessage("Agent type settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save agent type settings.");
    } finally {
      setSaving(false);
    }
  }, [draftAgentTypes, onChange]);

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div>
      <h3 className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Available agent types
      </h3>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Choose which agent runtimes can be created from the app. Disabled types are removed from the create-agent dialog.
      </p>

      <div className="max-w-lg space-y-2">
        {AGENT_TYPES.map((agentType) => {
          const checked = draftAgentTypes.includes(agentType);
          const disabled = checked && draftAgentTypes.length === 1;
          return (
            <label
              key={agentType}
              className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50"
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => toggleAgentType(agentType)}
                className="h-4 w-4 rounded border-border accent-primary"
                data-testid={`agent-type-toggle-${agentType}`}
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">{AGENT_TYPE_LABELS[agentType]}</div>
                <div className="text-xs text-muted-foreground">
                  {disabled ? "At least one agent type must stay enabled." : "Available in the create-agent dialog."}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      {message ? <p className="mt-3 text-sm text-status-working">{message}</p> : null}

      <div className="mt-4">
        <Button
          variant="primary"
          disabled={saving || !hasChanges}
          onClick={() => void handleSave()}
          data-testid="save-agent-type-settings"
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
