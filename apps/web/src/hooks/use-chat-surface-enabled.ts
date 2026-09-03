import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export const CHAT_SURFACE_ENDPOINT = "/api/v1/app/settings/chat-surface";
export const CHAT_SURFACE_QUERY_KEY = ["settings", "chat-surface"] as const;

type ToggleSettingResponse = { enabled: boolean };

/**
 * The `chat_surface_enabled` feature flag. The server owns the value; this is
 * a long-lived React Query cache of it, written through by the settings
 * toggle (see `useChatSurfaceSettingState`) so the tab bar and routing react
 * the moment the user flips it — no reload, no atom.
 */
export function useChatSurfaceEnabled(): { enabled: boolean; loaded: boolean } {
  const { data } = useQuery<ToggleSettingResponse>({
    queryKey: CHAT_SURFACE_QUERY_KEY,
    queryFn: () => api<ToggleSettingResponse>(CHAT_SURFACE_ENDPOINT),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  return { enabled: data?.enabled ?? false, loaded: data !== undefined };
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
