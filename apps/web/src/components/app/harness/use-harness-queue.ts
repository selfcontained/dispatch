import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

import { harnessTurnsQueryKey } from "./use-harness-turns";

/**
 * Actions on prompts that wait behind the running turn: send one now (it
 * jumps the queue and the running turn is interrupted) or drop it. Both
 * refetch the turns, which carry the queue.
 */
export function useHarnessQueue(agentId: string | null): {
  sendNow: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** The queued prompt whose action is in flight, if any. */
  busyId: string | null;
} {
  const queryClient = useQueryClient();
  const refetch = () =>
    queryClient.invalidateQueries({
      queryKey: harnessTurnsQueryKey(agentId),
      exact: true,
    });
  const sendNow = useMutation<void, Error, string>({
    mutationFn: (id) =>
      api<void>(
        `/api/v1/agents/${agentId}/harness/queue/${encodeURIComponent(id)}/send-now`,
        { method: "POST" }
      ),
    onSettled: refetch,
  });
  const remove = useMutation<void, Error, string>({
    mutationFn: (id) =>
      api<void>(
        `/api/v1/agents/${agentId}/harness/queue/${encodeURIComponent(id)}`,
        { method: "DELETE" }
      ),
    onSettled: refetch,
  });
  return {
    sendNow: sendNow.mutateAsync,
    remove: remove.mutateAsync,
    busyId: sendNow.isPending
      ? (sendNow.variables ?? null)
      : remove.isPending
        ? (remove.variables ?? null)
        : null,
  };
}

/** Stop: cancel the running turn. What is queued runs next. */
export function useHarnessInterrupt(agentId: string | null): {
  interrupt: () => Promise<void>;
  interrupting: boolean;
} {
  const queryClient = useQueryClient();
  const interrupt = useMutation<void, Error, void>({
    mutationFn: () =>
      api<void>(`/api/v1/agents/${agentId}/harness/interrupt`, {
        method: "POST",
      }),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: harnessTurnsQueryKey(agentId),
        exact: true,
      }),
  });
  return {
    interrupt: interrupt.mutateAsync,
    interrupting: interrupt.isPending,
  };
}
