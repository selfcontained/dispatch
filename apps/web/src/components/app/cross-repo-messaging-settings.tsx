import { useAtom } from "jotai";

import { ToggleSettingCard } from "@/components/app/toggle-setting-card";
import { useOptimisticToggleSetting } from "@/hooks/use-optimistic-toggle-setting";
import { crossRepoMessagingEnabledAtom } from "@/lib/store";

const ENDPOINT = "/api/v1/app/settings/cross-repo-messaging";

/**
 * Toggle for the server-wide cross-repo messaging gate. The gate is enforced
 * server-side (a single settings row read by the MCP handler for every agent),
 * so the server is the source of truth: on mount we GET the current value and
 * hydrate the jotai atom from it, and we only ever POST in response to an
 * explicit user toggle. The atom is a cached view that keeps the checkbox
 * reactive and gives an instant first paint; it is never re-asserted to the
 * server on its own.
 */
export function CrossRepoMessagingSettings(): JSX.Element {
  const atomState = useAtom(crossRepoMessagingEnabledAtom);
  const { enabled, error, setEnabled } = useOptimisticToggleSetting({
    endpoint: ENDPOINT,
    loadErrorMessage: "Failed to load cross-repo messaging setting.",
    saveErrorMessage: "Failed to save cross-repo messaging setting.",
    state: atomState,
  });

  return (
    <ToggleSettingCard
      eyebrow="Cross-repo messaging"
      description="By default agents can only message and list other agents in the same git repository. Enable this to let agents coordinate across repositories for local multi-repo workflows. Applies to all agents on this Dispatch server."
      label="Allow messaging agents in other repositories"
      hint="When on, name-based targeting can match agents across all repos — use the agent ID (agt_…) to address one unambiguously."
      testId="cross-repo-messaging-toggle"
      checked={enabled}
      onCheckedChange={setEnabled}
      error={error}
    />
  );
}
