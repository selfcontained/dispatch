import { ToggleSettingCard } from "@/components/app/toggle-setting-card";
import { useOptimisticToggleSetting } from "@/hooks/use-optimistic-toggle-setting";

const ENDPOINT = "/api/v1/app/settings/injection-hold";

/**
 * Toggle for the server-wide injection quiet gate. Enforced server-side (the
 * InjectionCoordinator consults it per injection), so the server is the
 * source of truth: GET on mount, POST only on explicit user toggle. Off by
 * default — automated prompts inject immediately, pre-gate behavior.
 */
export function InjectionHoldSettings(): JSX.Element {
  const { enabled, error, setEnabled } = useOptimisticToggleSetting({
    endpoint: ENDPOINT,
    loadErrorMessage: "Failed to load prompt delivery setting.",
    saveErrorMessage: "Failed to save prompt delivery setting.",
  });

  return (
    <ToggleSettingCard
      eyebrow="Prompt delivery"
      description="Dispatch injects automated prompts (reviews, agent messages, feedback) into an agent's terminal — the same input you type into. Enable this to hold those prompts while you're actively typing and deliver them when you pause. Applies to all agents on this Dispatch server."
      label="Hold automated prompts while you type"
      hint="When on, a badge appears over the terminal while a prompt waits (up to 60s) — click it to deliver immediately. When off, prompts inject as soon as they arrive."
      testId="injection-hold-toggle"
      checked={enabled}
      onCheckedChange={setEnabled}
      error={error}
    />
  );
}
