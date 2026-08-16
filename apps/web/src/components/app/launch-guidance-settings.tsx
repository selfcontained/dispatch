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
 * plugin is installed in the CLI, so the copy states it as a requirement.
 *
 * The checkbox stays disabled until the GET lands: an unread value must not
 * render as a confirmed "off", since the wrong belief here silently changes
 * the guidance of every agent launched afterwards.
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
        Shorten the startup rules injected into new Claude Code and Codex
        agents. Requires the Dispatch plugin — its skills and the MCP tool
        descriptions carry the detail the rules drop.
      </p>
      <label className="flex w-fit cursor-pointer items-center gap-3 text-sm text-foreground">
        <Checkbox
          checked={enabled}
          disabled={!loaded}
          onCheckedChange={(checked) => handleToggle(checked === true)}
          data-testid="launch-guidance-trim-toggle"
        />
        Use short startup rules
      </label>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
