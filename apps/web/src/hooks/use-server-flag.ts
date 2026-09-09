import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

export type ServerFlagSetting = {
  /** The confirmed value, or the optimistic one while a write is in flight. */
  enabled: boolean;
  /** False until either the fetch or a toggle has produced a value. */
  loaded: boolean;
  /** Empty string when there is nothing to report. */
  error: string;
  setEnabled: (next: boolean) => void;
};

/**
 * The settings-page toggle for a `useServerFlag` flag. One state machine over
 * the same query the flag reads: the GET is that query's own fetch, a toggle
 * writes the optimistic value straight into the cache and cancels any GET
 * still in flight (so a slow initial fetch cannot land after a successful
 * toggle and revert it), and a failed POST rolls the cache back to the last
 * confirmed value. Nothing here fetches on its own.
 *
 * Writes are sequence-guarded: only the newest toggle's outcome touches the
 * cache, so two quick flips cannot leave the UI on the older value.
 *
 * `messages.save` is shown when a POST fails without a message of its own;
 * `messages.load` when the initial GET failed and nothing has produced a
 * value yet.
 */
export function useServerFlagSetting(
  endpoint: string,
  hintAtom: ServerFlagHintAtom,
  messages: { save: string; load: string }
): ServerFlagSetting {
  const queryClient = useQueryClient();
  const { enabled, loaded } = useServerFlag(endpoint, hintAtom);
  const queryKey = serverFlagQueryKey(endpoint);
  const { isError: loadFailed } = useQuery<ServerFlagResponse>({
    queryKey,
    queryFn: () => api<ServerFlagResponse>(endpoint),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const latestWrite = useRef(0);

  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      api<ServerFlagResponse>(endpoint, {
        method: "POST",
        body: JSON.stringify({ enabled: next }),
      }),
    onMutate: async (next) => {
      const seq = (latestWrite.current += 1);
      // A GET still in flight would otherwise resolve after this toggle and
      // overwrite the optimistic value with the pre-toggle one.
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ServerFlagResponse>(queryKey);
      queryClient.setQueryData<ServerFlagResponse>(queryKey, {
        enabled: next,
      });
      return { seq, previous };
    },
    onSuccess: (data, _next, context) => {
      if (context?.seq !== latestWrite.current) return;
      queryClient.setQueryData<ServerFlagResponse>(queryKey, data);
    },
    onError: (_error, _next, context) => {
      if (context?.seq !== latestWrite.current) return;
      if (context.previous !== undefined) {
        queryClient.setQueryData(queryKey, context.previous);
      } else {
        // Nothing confirmed to fall back to: let the query fetch it again.
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });

  const { mutate, reset } = mutation;
  const setEnabled = useCallback(
    (next: boolean) => {
      reset();
      mutate(next);
    },
    [mutate, reset]
  );

  const error = mutation.isError
    ? mutation.error instanceof Error && mutation.error.message
      ? mutation.error.message
      : messages.save
    : loadFailed && !loaded
      ? messages.load
      : "";

  return { enabled, loaded, error, setEnabled };
}
