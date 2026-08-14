import { useCallback, useEffect, useRef, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api";

type LaunchGuidanceTrimResponse = { enabled: boolean };

const ENDPOINT = "/api/v1/app/settings/launch-guidance-trim";

/**
 * Toggle for the trimmed launch-guidance variant. Enforced server-side (the
 * guidance string is composed at agent launch), so the server is the source of
 * truth: GET on mount, POST only on explicit user toggle. Off by default.
 *
 * This is a user assertion, not detection — Dispatch cannot see whether the
 * plugin is installed in the CLI, so the copy has to say what turning it on
 * without the plugin costs.
 */
export function LaunchGuidanceSettings(): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState("");
  const latestReq = useRef(0);
  const confirmedValue = useRef(false);

  useEffect(() => {
    const seq = (latestReq.current += 1);
    void api<LaunchGuidanceTrimResponse>(ENDPOINT)
      .then((data) => {
        if (seq === latestReq.current) {
          confirmedValue.current = data.enabled;
          setEnabled(data.enabled);
        }
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
    void api<LaunchGuidanceTrimResponse>(ENDPOINT, {
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
      });
  }, []);

  return (
    <div className="p-6">
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Launch guidance
      </div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Dispatch injects a set of startup rules into every agent. The Dispatch
        plugin covers some of the same ground as discoverable skills, so those
        rules can be shortened for agents that have it installed. Applies to all
        agents on this Dispatch server.
      </p>
      <div className="max-w-lg">
        <label className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50">
          <Checkbox
            checked={enabled}
            onCheckedChange={(checked) => handleToggle(checked === true)}
            data-testid="launch-guidance-trim-toggle"
          />
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">
              I have the Dispatch plugin installed — trim the startup rules
            </div>
            <div className="text-xs text-muted-foreground">
              Shortens the browser-validation and Autonomous Review rules, whose
              detail the plugin&apos;s <code>ui-validation</code>,{" "}
              <code>sharing</code>, and <code>review-workflow</code> skills
              carry. Status reporting, pinning, and session naming are never
              trimmed. Dispatch can&apos;t verify the plugin is installed — turn
              this on without it and that guidance is simply gone. Only affects
              Claude Code and Codex agents (the plugin&apos;s platforms), and
              only agents launched after the change.
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
