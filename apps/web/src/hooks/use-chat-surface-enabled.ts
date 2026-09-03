import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";

import { api } from "@/lib/api";
import { chatSurfaceEnabledHintAtom } from "@/lib/store";

export const CHAT_SURFACE_ENDPOINT = "/api/v1/app/settings/chat-surface";
const CHAT_SURFACE_QUERY_KEY = ["settings", "chat-surface"] as const;

type ToggleSettingResponse = { enabled: boolean };

/**
 * The `chat_surface_enabled` feature flag. The server owns the value; this is
 * a long-lived React Query cache of it, written through by the settings
 * toggle (see `useChatSurfaceSettingState`) so the tab bar and routing react
 * the moment the user flips it — no reload, no atom for the live value.
 *
 * Until the fetch resolves the last value this browser saw stands in for it
 * (`chatSurfaceEnabledHintAtom`), so the first paint of an agent already
 * knows which tab to show. `loaded` is false only on a browser that has never
 * fetched the flag; callers hold tab-dependent rendering until then. If the
 * hint turns out stale the routing reconciles as soon as the server answers.
 */
export function useChatSurfaceEnabled(): { enabled: boolean; loaded: boolean } {
  const [hint, setHint] = useAtom(chatSurfaceEnabledHintAtom);
  const { data } = useQuery<ToggleSettingResponse>({
    queryKey: CHAT_SURFACE_QUERY_KEY,
    queryFn: () => api<ToggleSettingResponse>(CHAT_SURFACE_ENDPOINT),
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

/**
 * A `[value, set]` pair for `useOptimisticToggleSetting`'s `state` option that
 * lives in the same query cache `useChatSurfaceEnabled` reads from.
 */
export function useChatSurfaceSettingState(): readonly [
  boolean,
  (next: boolean) => void,
] {
  const queryClient = useQueryClient();
  const { enabled } = useChatSurfaceEnabled();
  const set = useCallback(
    (next: boolean) => {
      queryClient.setQueryData<ToggleSettingResponse>(CHAT_SURFACE_QUERY_KEY, {
        enabled: next,
      });
    },
    [queryClient]
  );
  return [enabled, set] as const;
}
