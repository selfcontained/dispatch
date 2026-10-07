export type ScheduledMessageStatus =
  | "active"
  | "paused"
  | "completed"
  | "cancelled"
  | "expired"
  | "limit_reached"
  | "uncertain";
export type ScheduledMessage = {
  id: string;
  agentId: string;
  title: string;
  message: string;
  stopWhen: string | null;
  deliverAt: string;
  intervalSeconds: number | null;
  expiresAt: string;
  maxDeliveries: number;
  deliveredCount: number;
  nextDueAt: string;
  status: ScheduledMessageStatus;
  createdAt: string;
  cardId: string | null;
  outstanding: null | {
    id: string;
    phase: "pending" | "submitting" | "accepted";
    dueAt: string;
    ticks: number;
    blockId: string | null;
    retryAt?: string;
    pickedUp: boolean;
    settled: boolean;
  };
  error: string | null;
};

/** Durable presentation fallback; the delivery envelope is stored separately. */
export type ScheduledMessagePresentation = Pick<
  ScheduledMessage,
  | "title"
  | "message"
  | "intervalSeconds"
  | "expiresAt"
  | "maxDeliveries"
  | "deliveredCount"
  | "nextDueAt"
  | "status"
>;

/** Human-readable cadence without fractional units. */
export function scheduledMessageCadence(
  intervalSeconds: number | null
): string {
  if (!intervalSeconds) return "One-time message";
  const units: [number, string][] = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  let remaining = intervalSeconds;
  const parts: string[] = [];
  for (const [size, name] of units) {
    const count = Math.floor(remaining / size);
    remaining %= size;
    if (count) parts.push(`${count} ${name}${count === 1 ? "" : "s"}`);
  }
  return `Every ${parts.join(" ")}`;
}
