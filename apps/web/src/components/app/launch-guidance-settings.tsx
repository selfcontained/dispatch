import { useCallback, useEffect, useRef, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api";

type LaunchGuidanceTrimResponse = { enabled: boolean };

const ENDPOINT = "/api/v1/app/settings/launch-guidance-trim";
const DETAIL_ID = "launch-guidance-trim-detail";

/**
 * Toggle for the trimmed launch-guidance variant. Enforced server-side (the
 * guidance string is composed at agent launch), so the server is the source of
 * truth: GET on mount, POST only on explicit user toggle. Off by default.
 *
 * This is a user assertion, not detection — Dispatch cannot see whether the
 * plugin is installed in the CLI, so the copy leads with what turning it on
 * without the plugin costs, and the checkbox stays disabled until the GET
 * lands. An unread value must not render as a confirmed "off": the wrong
 * belief here silently drops guidance from every agent launched afterwards.
 */
export function LaunchGuidanceSettings(): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const latestReq = useRef(0);
  const confirmedValue = useRef(false);
  // Writes are chained, not just sequence-guarded: two quick toggles could
  // otherwise land at the server out of order and leave it on the older
  // value while the UI showed the newer one.
  const pendingWrite = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    const seq = (latestReq.current += 1);
    void api<LaunchGuidanceTrimResponse>(ENDPOINT)
      .then((data) => {
        if (seq !== latestReq.current) return;
        confirmedValue.current = data.enabled;
        setEnabled(data.enabled);
        setLoaded(true);
      })
      .catch(() => {
        if (seq === latestReq.current) {
          setError("Failed to load launch guidance setting.");
        }
      });
  }, []);

  const handleToggle = useCallback((next: boolean) => {
    const seq = (latestReq.current += 1);
    setError("");
    setEnabled(next);
    pendingWrite.current = pendingWrite.current
      .catch(() => undefined)
      .then(() =>
        api<LaunchGuidanceTrimResponse>(ENDPOINT, {
          method: "POST",
          body: JSON.stringify({ enabled: next }),
        })
          .then(() => {
            if (seq === latestReq.current) confirmedValue.current = next;
          })
          .catch((err) => {
            if (seq !== latestReq.current) return;
            setEnabled(confirmedValue.current);
            setError(
              err instanceof Error
                ? err.message
                : "Failed to save launch guidance setting."
            );
          })
      );
  }, []);

  return (
    <div className="p-6">
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Launch guidance
      </div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Dispatch injects a set of startup rules into every agent. Most of their
        detail is already in the MCP tool descriptions, and the rest is in the
        Dispatch plugin&apos;s skills — so the rules can be short pointers
        instead. Applies to all agents on this Dispatch server.
      </p>
      <div className="max-w-lg">
        <label className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50">
          <Checkbox
            checked={enabled}
            disabled={!loaded}
            onCheckedChange={(checked) => handleToggle(checked === true)}
            aria-label="Trim the startup rules — I have the Dispatch plugin installed"
            aria-describedby={DETAIL_ID}
            data-testid="launch-guidance-trim-toggle"
          />
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">
              Use short startup rules — I have the Dispatch plugin installed
            </div>
            <div id={DETAIL_ID} className="text-xs text-muted-foreground">
              Status reporting, pinning, and session naming shrink to one line
              each; their detail is in the <code>dispatch_event</code> and{" "}
              <code>dispatch_pin</code> tool descriptions, which every agent
              already reads. The browser-validation and pull-request rules drop
              entirely, and those <em>do</em> need the plugin&apos;s{" "}
              <code>ui-validation</code>, <code>sharing</code>, and{" "}
              <code>review-workflow</code> skills to replace them — Dispatch
              can&apos;t verify it&apos;s installed, so turn this on only if it
              is. Only affects Claude Code and Codex agents, and only agents
              launched after the change.
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
