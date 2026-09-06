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
  /** Cancel the running turn; what is queued runs next. */
  interrupt: () => Promise<void>;
  interrupting: boolean;
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
  const interrupt = useMutation<void, Error, void>({
    mutationFn: () =>
      api<void>(`/api/v1/agents/${agentId}/harness/interrupt`, {
        method: "POST",
      }),
    onSettled: refetch,
  });
  return {
    sendNow: sendNow.mutateAsync,
    remove: remove.mutateAsync,
    interrupt: interrupt.mutateAsync,
    interrupting: interrupt.isPending,
    busyId: sendNow.isPending
      ? (sendNow.variables ?? null)
      : remove.isPending
        ? (remove.variables ?? null)
        : null,
  };
}
