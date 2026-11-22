import { type RunnerHealth, workspaceLocator } from "@dispatch/runner-protocol";
import type { RunnerUpdateAction, RunnerUpdateView } from "@dispatch/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type RunnerStatus = "pending" | "online" | "offline" | "revoked";

export type Runner = {
  id: string;
  name: string;
  status: RunnerStatus;
  workspaces: string[];
  managedWorkspace?: true;
  engineManagement?: true;
  engineCapabilities?: true;
  githubManagement?: boolean;
  repositoryPicker?: boolean;
  health?: RunnerHealth;
  healthReceivedAt?: string;
  update?: RunnerUpdateView;
};

export type RunnerPairing = { id: string; command: string; expiresAt: string };

export const runnersQueryKey = ["runners"] as const;

/** Locator the server stores in an agent's cwd: opaque runner id, both parts encoded. */
export function runnerLocator(runnerId: string, workspace: string): string {
  return workspaceLocator({ runner: runnerId, workspace });
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

export function useRunnerName(runnerId: string | undefined) {
  const { data } = useRunners({
    enabled: Boolean(runnerId),
    includeCleared: true,
  });
  return runnerId
    ? (data?.find((runner) => runner.id === runnerId)?.name ?? "Remote runner")
    : undefined;
}

export function useStartRunnerUpdate(runnerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: RunnerUpdateAction) =>
      api<{ attemptId: string }>(
        `/api/v1/runners/${encodeURIComponent(runnerId)}/update`,
        { method: "POST", body: JSON.stringify({ action }) }
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
