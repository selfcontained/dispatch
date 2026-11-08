import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { api } from "@/lib/api";

type Pending = {
  turnId: number;
  streamId: string;
  threadId: string | null;
  startedAt: number;
};
/** Server lifecycle state, scoped to this conversation; no optimistic or shadow spinner. */
export function RoutingIndicator({
  streamId,
  threadId = null,
  active = true,
}: {
  streamId: string | null;
  threadId?: string | null;
  active?: boolean;
}) {
  const settings = useQuery({
    queryKey: ["routing-experiment-settings"],
    queryFn: () =>
      api<{ mode: string; configured: boolean }>(
        "/api/v1/experiments/routing/settings"
      ),
    staleTime: 5000,
    retry: false,
    refetchInterval: (query) =>
      query.state.error ? false : active ? 5000 : false,
  });
  const pending = useQuery({
    queryKey: ["routing-pending", streamId],
    queryFn: () =>
      api<{ pending: Pending[] }>(
        `/api/v1/experiments/routing/pending?streamId=${encodeURIComponent(streamId!)}`
      ),
    enabled:
      !!streamId &&
      active &&
      settings.data?.mode === "active" &&
      settings.data?.configured === true,
    refetchInterval: (query) =>
      query.state.data?.pending?.length ? 150 : 1000,
    staleTime: 0,
  });
  const item =
    active && settings.data?.mode === "active"
      ? pending.data?.pending?.find(
          (p) => p.streamId === streamId && p.threadId === threadId
        )
      : undefined;
  const turn = item?.turnId;
  const startedAt = item?.startedAt;
  const [visible, setVisible] = useState<number>();
  useEffect(() => {
    setVisible(undefined);
    if (turn === undefined) return;
    const timer = setTimeout(
      () => setVisible(turn),
      Math.max(0, 300 - (Date.now() - (startedAt ?? Date.now())))
    );
    return () => clearTimeout(timer);
  }, [turn, startedAt]);
  return (
    <div
      className="pointer-events-none absolute bottom-2 left-5 z-10 h-5 w-5"
      aria-live="polite"
    >
      {turn !== undefined && visible === turn && (
        <span
          role="status"
          aria-label="Choosing reply location"
          title="Choosing reply location"
          className="inline-flex text-primary"
        >
          <Sparkles
            aria-hidden="true"
            className="h-4 w-4 motion-safe:animate-pulse motion-reduce:animate-none"
          />
        </span>
      )}
    </div>
  );
}
