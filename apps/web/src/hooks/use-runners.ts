import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type RunnerStatus = "pending" | "online" | "offline" | "revoked";

export type Runner = {
  id: string;
  name: string;
  status: RunnerStatus;
  workspaces: string[];
};

export type RunnerPairing = { id: string; command: string; expiresAt: string };

export const runnersQueryKey = ["runners"] as const;

/** Locator the server stores in an agent's cwd: opaque runner id, both parts encoded. */
export function runnerLocator(runnerId: string, workspace: string): string {
  return `runner://${encodeURIComponent(runnerId)}/${encodeURIComponent(workspace)}`;
}

export function useRunners(options: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: runnersQueryKey,
    queryFn: async () =>
      (await api<{ runners: Runner[] }>("/api/runners")).runners,
    refetchInterval: options.poll ? 5000 : false,
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
