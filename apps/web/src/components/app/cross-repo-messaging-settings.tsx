import { useAtom } from "jotai";

import { Checkbox } from "@/components/ui/checkbox";
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
    <div className="p-6">
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Cross-repo messaging
      </div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        By default agents can only message and list other agents in the same git
        repository. Enable this to let agents coordinate across repositories for
        local multi-repo workflows. Applies to all agents on this Dispatch
        server.
      </p>
      <div className="max-w-lg">
        <label className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50">
          <Checkbox
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked === true)}
            data-testid="cross-repo-messaging-toggle"
          />
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">
              Allow messaging agents in other repositories
            </div>
            <div className="text-xs text-muted-foreground">
              When on, name-based targeting can match agents across all repos —
              use the agent ID (agt_…) to address one unambiguously.
            </div>
          </div>
        </label>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
