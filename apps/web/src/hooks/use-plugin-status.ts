import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type {
  PluginEngine as PluginAgentType,
  PluginStatus,
} from "@dispatch/runner-protocol/plugin-engines";
import type { EngineScope } from "@dispatch/runner-protocol/engine-management";

import { engineScopeQuery, LOCAL_ENGINE_SCOPE } from "@/lib/engine-management";
import { runnerEngineCapability } from "@/lib/engine-management";
import { toast } from "@/components/ui/toast";

export type { PluginAgentType, PluginStatus };

export const AGENT_TYPE_LABELS: Record<PluginAgentType, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export const pluginStatusKey = (scope: EngineScope) =>
  ["plugin", "status", engineScopeQuery(scope)] as const;
export const PLUGIN_STATUS_QUERY_KEY = pluginStatusKey(LOCAL_ENGINE_SCOPE);

type PluginStatusResponse = { statuses: PluginStatus[] };

export function usePluginStatus(scope: EngineScope = LOCAL_ENGINE_SCOPE) {
  return useQuery<PluginStatusResponse>({
    queryKey: pluginStatusKey(scope),
    queryFn: () =>
      api<PluginStatusResponse>(
        `/api/v1/engine-management/plugins?${engineScopeQuery(scope)}`
      ),
    // The server caches its own check for up to an hour (each check does a
    // git fetch); no need to poll faster than that from here.
    staleTime: 5 * 60 * 1000,
  });
}

type UpdatePluginResponse = { status: PluginStatus };

export function useUpdatePlugin(
  action: "update" | "install" = "update",
  scope: EngineScope = LOCAL_ENGINE_SCOPE
) {
  const queryClient = useQueryClient();
  return useMutation<UpdatePluginResponse, Error, PluginAgentType>({
    mutationFn: async (agentType) => {
      const { status } = await runnerEngineCapability(
        scope,
        {
          type: action === "install" ? "plugin_install" : "plugin_update",
          engine: agentType,
          plugin: "dispatch@dispatch",
        },
        "plugin_status"
      );
      return { status: { ...status, agentType } };
    },
    onSuccess: (data) => {
      queryClient.setQueryData<PluginStatusResponse>(
        pluginStatusKey(scope),
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
      if (data.status.detectionError || !data.status.installed) {
        toast.warning(`Couldn’t confirm the ${label} plugin.`, {
          description: "The command finished. Retry the status check.",
        });
      } else if (data.status.updateAvailable) {
        toast.warning(`${label} is still on v${data.status.currentVersion}.`, {
          description: "The update ran. Check again, or run it manually.",
        });
      } else {
        toast.success(
          `Dispatch plugin ${action === "install" ? "installed" : "updated"} for ${label}.`,
          { description: "Start a fresh agent session to load it." }
        );
      }
    },
    onError: () => {
      // A failed update can still have refreshed the marketplace snapshot
      // server-side (the error surfaces the mutating step, not the
      // refresh). Refetch rather than trust stale client state.
      void queryClient.invalidateQueries({ queryKey: pluginStatusKey(scope) });
    },
  });
}

export function useRefreshPluginStatus(
  scope: EngineScope = LOCAL_ENGINE_SCOPE
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<PluginStatusResponse>(
        `/api/v1/engine-management/plugins?${engineScopeQuery(scope)}&refresh=true`
      ),
    onSuccess: (data) => queryClient.setQueryData(pluginStatusKey(scope), data),
  });
}
