import { useCallback, useEffect, useRef, useState } from "react";
import { useAtom } from "jotai";

import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api";
import { crossRepoMessagingEnabledAtom } from "@/lib/store";

type CrossRepoMessagingResponse = { enabled: boolean };

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
  const [enabled, setEnabled] = useAtom(crossRepoMessagingEnabledAtom);
  const [error, setError] = useState("");
  // Monotonic id for the most recent request (mount GET or a toggle). A
  // response only applies if it is still the latest, so a stale mount GET or
  // an out-of-order toggle response can't clobber a newer user intent.
  const latestReq = useRef(0);

  useEffect(() => {
    const seq = (latestReq.current += 1);
    void api<CrossRepoMessagingResponse>(ENDPOINT)
      .then((data) => {
        if (seq === latestReq.current) setEnabled(data.enabled);
      })
      .catch(() => {
        if (seq === latestReq.current) {
          setError("Failed to load cross-repo messaging setting.");
        }
      });
  }, [setEnabled]);

  const handleToggle = useCallback(
    (next: boolean) => {
      const seq = (latestReq.current += 1);
      setError("");
      setEnabled(next);
      void api<CrossRepoMessagingResponse>(ENDPOINT, {
        method: "POST",
        body: JSON.stringify({ enabled: next }),
      }).catch((err) => {
        if (seq !== latestReq.current) return;
        // Revert the optimistic change — the server gate is unchanged.
        setEnabled(!next);
        setError(
          err instanceof Error
            ? err.message
            : "Failed to save cross-repo messaging setting."
        );
      });
    },
    [setEnabled]
  );

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
            onCheckedChange={(checked) => handleToggle(checked === true)}
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
