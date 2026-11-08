import { useEffect, useState, useSyncExternalStore } from "react";
import { onlineManager, useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { api } from "@/lib/api";

type Pending = {
  turnId: number;
  streamId: string;
  threadId: string | null;
  startedAt: number;
  deadlineAt?: number;
};
const subscribeOnline = (onChange: () => void) =>
  onlineManager.subscribe(onChange);

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
  const online = useSyncExternalStore(
    subscribeOnline,
    () => onlineManager.isOnline(),
    () => true
  );
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
    active &&
    online &&
    !settings.isError &&
    settings.data?.mode === "active" &&
    settings.data?.configured === true &&
    !pending.isError &&
    pending.failureCount === 0 &&
    pending.fetchStatus !== "paused"
      ? pending.data?.pending?.find(
          (p) => p.streamId === streamId && p.threadId === threadId
        )
      : undefined;
  const turn = item?.turnId;
  const startedAt = item?.startedAt;
  // Production routing has a three-second total deadline. An explicit server
  // deadline can shorten it; cached rows cannot extend the default bound.
  const deadlineAt =
    startedAt === undefined
      ? undefined
      : Math.min(item?.deadlineAt ?? Infinity, startedAt + 3000);
  const [visible, setVisible] = useState<number>();
  useEffect(() => {
    setVisible(undefined);
    if (
      turn === undefined ||
      startedAt === undefined ||
      deadlineAt === undefined ||
      !Number.isFinite(deadlineAt)
    )
      return;
    const remaining = deadlineAt - Date.now();
    const showAfter = Math.max(0, startedAt + 300 - Date.now());
    if (remaining <= showAfter) return;
    const showTimer = setTimeout(() => setVisible(turn), showAfter);
    const expiryTimer = setTimeout(() => setVisible(undefined), remaining);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(expiryTimer);
    };
  }, [turn, startedAt, deadlineAt]);
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
