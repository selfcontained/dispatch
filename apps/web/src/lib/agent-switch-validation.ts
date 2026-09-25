const VALIDATION_PARAM = "agentSwitchValidation";
const VALIDATION_KEY = "dispatch:agent-switch-validation";

export type AgentSwitchValidationMode = "before" | "after" | null;

function readValidationMode(): AgentSwitchValidationMode {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;

  try {
    const requested = new URLSearchParams(window.location.search).get(
      VALIDATION_PARAM
    );
    if (requested === "before" || requested === "after") {
      window.sessionStorage.setItem(VALIDATION_KEY, requested);
      return requested;
    }
    const stored = window.sessionStorage.getItem(VALIDATION_KEY);
    return stored === "before" || stored === "after" ? stored : null;
  } catch {
    return null;
  }
}

// Kept across sidebar navigation, which intentionally drops search params.
// Production builds always use the fixed behavior.
export const agentSwitchValidationMode = readValidationMode();
