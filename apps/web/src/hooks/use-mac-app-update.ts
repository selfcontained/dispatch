import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  MacAppUpdateAction,
  MacAppUpdateSnapshot,
} from "@dispatch/shared";

import { api } from "@/lib/api";

/** Kept current by `mac_app.update_changed` events on the UI stream. */
export const MAC_APP_UPDATE_QUERY_KEY = ["mac-app", "update"] as const;

export function useMacAppUpdate() {
  return useQuery<MacAppUpdateSnapshot>({
    queryKey: MAC_APP_UPDATE_QUERY_KEY,
    queryFn: () => api<MacAppUpdateSnapshot>("/api/v1/mac-app/update"),
    staleTime: Infinity,
    // Installing stops this server and with it the UI stream. Failed polls keep
    // the last data, so this polls until the updated server answers.
    refetchInterval: (query) =>
      query.state.data?.state?.phase === "installing" ? 3_000 : false,
    retry: false,
  });
}

export function useMacAppUpdateAction() {
  return useMutation({
    mutationFn: (action: MacAppUpdateAction) =>
      api<{ ok: true }>("/api/v1/mac-app/update", {
        method: "POST",
        body: JSON.stringify({ action }),
      }),
  });
}
