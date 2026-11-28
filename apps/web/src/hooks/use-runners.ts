import type { RunnerHealth } from "@dispatch/runner-protocol";
import type { RunnerUpdateAction, RunnerUpdateView } from "@dispatch/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { api } from "@/lib/api";
import { subscribeServerVersion } from "@/lib/version";

export type RunnerStatus = "pending" | "online" | "offline" | "revoked";

export type Runner = {
  id: string;
  name: string;
  kind?: "local" | "enrolled";
  engineScope?: import("@dispatch/runner-protocol/engine-management").EngineScope;
  status?: RunnerStatus;
  engineManagement?: true;
  engineCapabilities?: true;
  githubManagement?: boolean;
  repositoryPicker?: boolean;
  health?: RunnerHealth;
  healthReceivedAt?: string;
  update?: RunnerUpdateView;
  automaticUpdates?: boolean;
};

export type RunnerPairing = { id: string; command: string; expiresAt: string };

export const runnersQueryKey = ["runners"] as const;
export const runnerInstallerQueryKey = ["runner-installer"] as const;

/**
 * The wanted build is cached for minutes and follows Dispatch's build. Read
 * it again when what is shown beside it moves, or Dispatch's version does.
 */
export function useWantedBuildRefresh({ health, update, kind }: Runner) {
  const queryClient = useQueryClient();
  const shown = JSON.stringify([
    health?.version,
    health?.revision,
    update?.available,
    update?.attempt,
    update?.result,
  ]);
  useEffect(() => {
    if (kind === "local") return;
    const refresh = () =>
      void queryClient.invalidateQueries({ queryKey: runnerInstallerQueryKey });
    refresh();
    return subscribeServerVersion(refresh);
  }, [queryClient, shown, kind]);
}

export function useRunners(
  options: { poll?: boolean; enabled?: boolean; includeCleared?: boolean } = {}
) {
  return useQuery({
    queryKey: options.includeCleared
      ? [...runnersQueryKey, "includeCleared"]
      : runnersQueryKey,
    enabled: options.enabled,
    queryFn: async () =>
      (
        await api<{ runners: Runner[] }>(
          options.includeCleared
            ? "/api/runners?includeCleared=true"
            : "/api/runners"
        )
      ).runners,
    refetchInterval: (query) => {
      if (!options.poll) return false;
      // An update's phases last seconds.
      return query.state.data?.some((runner) => runner.update?.attempt)
        ? 2000
        : 5000;
    },
  });
}

export function useRunnerUpdatePolicy(runnerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (automatic: boolean) =>
      api<{ automatic: boolean }>(
        `/api/v1/runners/${encodeURIComponent(runnerId)}/update-policy`,
        { method: "PATCH", body: JSON.stringify({ automatic }) }
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: runnersQueryKey }),
  });
}

export function useStartRunnerUpdate(runnerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      action:
        | RunnerUpdateAction
        | { action: "cancel" | "force"; attemptId: string }
    ) =>
      api<{ attemptId: string }>(
        `/api/v1/runners/${encodeURIComponent(runnerId)}/update`,
        {
          method: "POST",
          body: JSON.stringify(
            typeof action === "string" ? { action } : action
          ),
        }
      ),
    // A refusal also means the runner's state moved on.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: runnersQueryKey }),
  });
}

export function useRunnerMutations() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: runnersQueryKey });
  const pair = useMutation({
    mutationFn: (name: string) =>
      api<RunnerPairing>("/api/runners", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: invalidate,
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/api/runners/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  return { pair, revoke };
}
