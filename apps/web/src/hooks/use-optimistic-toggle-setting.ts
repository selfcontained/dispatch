import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";

type ToggleSettingResponse = { enabled: boolean };

export type OptimisticToggleSetting = {
  /** Current value: the server's confirmed value, or the optimistic one mid-write. */
  enabled: boolean;
  /** False until the GET lands. Use it to disable the control before the value is known. */
  loaded: boolean;
  /** Empty string when there is nothing to report. */
  error: string;
  setEnabled: (next: boolean) => void;
};

type Options = {
  /** Settings endpoint that GETs and POSTs `{ enabled: boolean }`. */
  endpoint: string;
  /** Shown when the mount GET fails. */
  loadErrorMessage: string;
  /** Shown when a POST fails without an error message of its own. */
  saveErrorMessage: string;
  /**
   * Optional externally-owned state cell (e.g. a `useAtom` pair) to hold the
   * value in, for settings that also want a cached view outside this hook.
   * Defaults to state local to the hook.
   */
  state?: readonly [boolean, (next: boolean) => void];
};

/**
 * Optimistic toggle for a server-wide boolean setting where the server is the
 * source of truth: GET the value on mount, POST only on an explicit user
 * toggle, and roll the checkbox back to the last confirmed value if the write
 * fails.
 *
 * Reads and writes are sequence-guarded so a stale response can never overwrite
 * a newer one, and writes are additionally chained: two quick toggles could
 * otherwise land at the server out of order and leave it on the older value
 * while the UI showed the newer one.
 */
export function useOptimisticToggleSetting({
  endpoint,
  loadErrorMessage,
  saveErrorMessage,
  state,
}: Options): OptimisticToggleSetting {
  const localState = useState(false);
  const [enabled, setEnabled] = state ?? localState;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const latestReq = useRef(0);
  const confirmedValue = useRef(enabled);
  const pendingWrite = useRef<Promise<unknown>>(Promise.resolve());
  // The setter may come from outside the hook, so keep it out of the effect's
  // dependency list — the GET must run once per endpoint, not per re-render.
  const setEnabledRef = useRef(setEnabled);
  setEnabledRef.current = setEnabled;

  useEffect(() => {
    const seq = (latestReq.current += 1);
    void api<ToggleSettingResponse>(endpoint)
      .then((data) => {
        if (seq !== latestReq.current) return;
        confirmedValue.current = data.enabled;
        setEnabledRef.current(data.enabled);
        setLoaded(true);
      })
      .catch(() => {
        if (seq === latestReq.current) setError(loadErrorMessage);
      });
  }, [endpoint, loadErrorMessage]);

  const handleToggle = useCallback(
    (next: boolean) => {
      const seq = (latestReq.current += 1);
      setError("");
      setEnabledRef.current(next);
      pendingWrite.current = pendingWrite.current
        .catch(() => undefined)
        .then(() =>
          api<ToggleSettingResponse>(endpoint, {
            method: "POST",
            body: JSON.stringify({ enabled: next }),
          })
            .then(() => {
              if (seq === latestReq.current) confirmedValue.current = next;
            })
            .catch((err) => {
              if (seq !== latestReq.current) return;
              setEnabledRef.current(confirmedValue.current);
              setError(err instanceof Error ? err.message : saveErrorMessage);
            })
        );
    },
    [endpoint, saveErrorMessage]
  );

  return { enabled, loaded, error, setEnabled: handleToggle };
}
