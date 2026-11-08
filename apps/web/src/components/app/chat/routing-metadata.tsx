import { useEffect, useState, useSyncExternalStore } from "react";
import { onlineManager } from "@tanstack/react-query";
import type { Block, RoutingPending } from "@dispatch/shared";
import { useRoutingPending } from "@/hooks/use-routing-pending";
import { RoutingDecision } from "./routing-decision";
const subscribeOnline = (notify: () => void) => onlineManager.subscribe(notify);
export function PendingRouting({ pending }: { pending: RoutingPending }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(false);
    const deadline = Math.min(pending.deadlineAt, pending.startedAt + 3000);
    const showAfter = Math.max(0, pending.startedAt + 300 - Date.now());
    const remaining = deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= showAfter) return;
    const show = setTimeout(() => setVisible(true), showAfter);
    const expire = setTimeout(() => setVisible(false), remaining);
    return () => {
      clearTimeout(show);
      clearTimeout(expire);
    };
  }, [pending.turnId, pending.startedAt, pending.deadlineAt]);
  return visible ? (
    <span
      role="status"
      aria-label="Choosing reply location"
      className="text-[11px] text-muted-foreground"
    >
      Routing…
    </span>
  ) : null;
}
/** Pending and retained evidence share one reserved message metadata line. */
export function RoutingMetadata({
  block,
  agentName,
}: {
  block: Block;
  agentName: (id: string) => string;
}) {
  const eligible =
    block.author.kind === "user" &&
    block.kind === "text" &&
    !!(
      block.toAgentId ||
      block.data?.mentions?.length ||
      block.data?.recipients?.length
    );
  const snapshot = useRoutingPending(block.streamId, eligible);
  const online = useSyncExternalStore(
    subscribeOnline,
    () => onlineManager.isOnline(),
    () => true
  );
  // A retained completion is authoritative over an older cached pending snapshot.
  const decisions = block.routing?.filter((d) => d.status !== "pending") ?? [];
  const pending =
    eligible && online && !snapshot.isError && snapshot.fetchStatus !== "paused"
      ? (snapshot.data?.pending?.filter(
          (p) =>
            p.streamId === block.streamId &&
            p.messageIds.includes(block.id) &&
            !decisions.some(
              (d) => d.turnId === p.turnId && d.agentId === p.agentId
            )
        ) ?? [])
      : [];
  if (!eligible && !block.routing?.length) return null;
  return (
    <div
      className="min-h-4 flex flex-wrap items-center gap-x-3"
      aria-live="polite"
    >
      {pending.map((p) => (
        <PendingRouting key={`${p.agentId}:${p.turnId}`} pending={p} />
      ))}
      {decisions.map((d) => (
        <RoutingDecision
          key={`${d.agentId}:${d.turnId}`}
          diagnostic={d}
          agentName={agentName(d.agentId)}
        />
      ))}
    </div>
  );
}
