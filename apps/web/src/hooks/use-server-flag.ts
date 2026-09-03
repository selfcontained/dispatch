import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { type WritableAtom, useAtom } from "jotai";

import { api } from "@/lib/api";

export type ServerFlagResponse = { enabled: boolean };

/** A persisted `boolean | null` atom, as `atomWithLocalStorage` produces. */
export type ServerFlagHintAtom = WritableAtom<
  boolean | null,
  [boolean | null | ((prev: boolean | null) => boolean | null)],
  void
>;

/** One query per endpoint; the setting hook writes through the same key. */
export function serverFlagQueryKey(endpoint: string) {
  return ["settings", endpoint] as const;
}

/**
 * A server-owned boolean feature flag served as `{ enabled }` from
 * `endpoint`. The value is a long-lived React Query cache the settings toggle
 * writes through, so anything reading the flag reacts the moment the user
 * flips it — no reload, no atom for the live value.
 *
 * Until the fetch resolves the last value this browser saw stands in for it
 * (`hintAtom`, persisted), so the first paint already knows the flag's likely
 * value. `loaded` is false only on a browser that has never fetched the flag;
 * callers hold flag-dependent rendering until then. If the hint turns out
 * stale the UI reconciles as soon as the server answers.
 */
export function useServerFlag(
  endpoint: string,
  hintAtom: ServerFlagHintAtom
): { enabled: boolean; loaded: boolean } {
  const [hint, setHint] = useAtom(hintAtom);
  const { data } = useQuery<ServerFlagResponse>({
    queryKey: serverFlagQueryKey(endpoint),
    queryFn: () => api<ServerFlagResponse>(endpoint),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (data === undefined || data.enabled === hint) return;
    setHint(data.enabled);
  }, [data, hint, setHint]);

  if (data !== undefined) return { enabled: data.enabled, loaded: true };
  return { enabled: hint ?? false, loaded: hint !== null };
}
