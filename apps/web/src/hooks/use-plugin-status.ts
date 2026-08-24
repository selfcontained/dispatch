import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
// Server-defined shape, imported type-only so nothing from the server
// reaches the web bundle (see use-cached-release-info.ts for the same
// pattern).
import type {
  PluginAgentType,
  PluginStatus,
} from "../../../server/src/shared/plugin-status";

export type { PluginAgentType, PluginStatus };

export const AGENT_TYPE_LABELS: Record<PluginAgentType, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export const PLUGIN_STATUS_QUERY_KEY = ["plugin", "status"] as const;

type PluginStatusResponse = { statuses: PluginStatus[] };

export function usePluginStatus() {
  return useQuery<PluginStatusResponse>({
    queryKey: PLUGIN_STATUS_QUERY_KEY,
    queryFn: () => api<PluginStatusResponse>("/api/v1/plugin/status"),
    // The server caches its own check for up to an hour (each check does a
    // git fetch); no need to poll faster than that from here.
    staleTime: 5 * 60 * 1000,
  });
}

type UpdatePluginResponse = { status: PluginStatus };

export function useUpdatePlugin() {
  const queryClient = useQueryClient();
  return useMutation<UpdatePluginResponse, Error, PluginAgentType>({
    mutationFn: (agentType) =>
      api<UpdatePluginResponse>("/api/v1/plugin/update", {
        method: "POST",
        body: JSON.stringify({ agentType }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData<PluginStatusResponse>(
        PLUGIN_STATUS_QUERY_KEY,
        (prev) => {
          const statuses = prev?.statuses ?? [];
          const next = statuses.filter(
            (s) => s.agentType !== data.status.agentType
          );
          next.push(data.status);
          return { statuses: next };
        }
      );
      const label = AGENT_TYPE_LABELS[data.status.agentType];
      // A 200 with the commands run successfully doesn't guarantee
      // updateAvailable flipped to false — the re-check could still see a
      // stale snapshot, or upstream could have published again in the
      // interim. Without this, that case renders as the row silently
      // resetting to exactly its pre-click state, indistinguishable from
      // the click doing nothing at all.
      if (data.status.updateAvailable) {
        toast.warning(
          `Update ran, but ${label} is still on v${data.status.currentVersion}.`
        );
      } else {
        toast.success(`Dispatch plugin updated for ${label}.`);
      }
    },
    onError: () => {
      // A failed update can still have refreshed the marketplace snapshot
      // server-side (the error surfaces the mutating step, not the
      // refresh). Refetch rather than trust stale client state.
      void queryClient.invalidateQueries({ queryKey: PLUGIN_STATUS_QUERY_KEY });
    },
  });
}
