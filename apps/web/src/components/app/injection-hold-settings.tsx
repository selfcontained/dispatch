import { useCallback, useEffect, useRef, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/api";

type InjectionHoldResponse = { enabled: boolean };

const ENDPOINT = "/api/v1/app/settings/injection-hold";

/**
 * Toggle for the server-wide injection quiet gate. Enforced server-side (the
 * InjectionCoordinator consults it per injection), so the server is the
 * source of truth: GET on mount, POST only on explicit user toggle. Off by
 * default — automated prompts inject immediately, pre-gate behavior.
 */
export function InjectionHoldSettings(): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState("");
  const latestReq = useRef(0);
  const confirmedValue = useRef(false);

  useEffect(() => {
    const seq = (latestReq.current += 1);
    void api<InjectionHoldResponse>(ENDPOINT)
      .then((data) => {
        if (seq === latestReq.current) {
          confirmedValue.current = data.enabled;
          setEnabled(data.enabled);
        }
      })
      .catch(() => {
        if (seq === latestReq.current) {
          setError("Failed to load prompt delivery setting.");
        }
      });
  }, []);

  const handleToggle = useCallback((next: boolean) => {
    const seq = (latestReq.current += 1);
    setError("");
    setEnabled(next);
    void api<InjectionHoldResponse>(ENDPOINT, {
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
            : "Failed to save prompt delivery setting."
        );
      });
  }, []);

  return (
    <div className="p-6">
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
        Prompt delivery
      </div>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Dispatch injects automated prompts (reviews, agent messages, feedback)
        into an agent&apos;s terminal — the same input you type into. Enable
        this to hold those prompts while you&apos;re actively typing and deliver
        them when you pause. Applies to all agents on this Dispatch server.
      </p>
      <div className="max-w-lg">
        <label className="flex cursor-pointer items-center gap-3 rounded border border-border px-3 py-2.5 transition-colors hover:bg-muted/50">
          <Checkbox
            checked={enabled}
            onCheckedChange={(checked) => handleToggle(checked === true)}
            data-testid="injection-hold-toggle"
          />
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">
              Hold automated prompts while you type
            </div>
            <div className="text-xs text-muted-foreground">
              When on, a badge appears over the terminal while a prompt waits
              (up to 60s) — click it to deliver immediately. When off, prompts
              inject as soon as they arrive.
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
