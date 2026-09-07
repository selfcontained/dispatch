import type { AgentPin } from "./types.js";

export type PinEventAction = "created" | "updated" | "deleted";

export type PinEvent = {
  pinId: string;
  label: string;
  action: PinEventAction;
};

/**
 * Consecutive updates to the same pin inside this window fold into one feed
 * entry (its timestamp moves to the latest write) instead of one line per
 * write. Progress pins get re-pinned every few seconds; a channel that
 * repeats them would bury everything else.
 */
export const PIN_UPDATE_COALESCE_SECONDS = 60;

/** Fields whose change is worth a line in the Chat feed. */
const NOTABLE_FIELDS = ["label", "value", "type", "caption"] as const;

/**
 * What changed between two pin arrays, as feed-worthy events. A pin whose
 * only change is a decoration (group, icon, variant…) produces nothing: the
 * sidebar re-renders, but there is nothing to tell the user about. The
 * returned order is the order of `after` for creates/updates, then deletes
 * in `before` order, so a batch write reads top to bottom like the sidebar.
 */
export function diffPins(
  before: readonly AgentPin[],
  after: readonly AgentPin[]
): PinEvent[] {
  const previous = new Map<string, AgentPin>();
  for (const pin of before) if (pin.id) previous.set(pin.id, pin);
  const events: PinEvent[] = [];
  const seen = new Set<string>();
  for (const pin of after) {
    if (!pin.id) continue;
    seen.add(pin.id);
    const old = previous.get(pin.id);
    if (!old) {
      events.push({ pinId: pin.id, label: pin.label, action: "created" });
      continue;
    }
    if (NOTABLE_FIELDS.some((field) => old[field] !== pin[field])) {
      events.push({ pinId: pin.id, label: pin.label, action: "updated" });
    }
  }
  for (const pin of before) {
    if (pin.id && !seen.has(pin.id)) {
      events.push({ pinId: pin.id, label: pin.label, action: "deleted" });
    }
  }
  return events;
}

type Queryable = {
  query: (
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>;
};

/**
 * Append `events` to `pin_events` for `agentId`. Meant to run inside the
 * transaction that wrote the pins, so the log never says something the
 * sidebar does not show (and every row of one write shares the
 * transaction's `now()`, which is how the feed groups a batch into one
 * entry).
 *
 * An update that lands within {@link PIN_UPDATE_COALESCE_SECONDS} of that
 * pin's previous update bumps the earlier row's timestamp instead of adding
 * one; see the constant for why.
 */
export async function recordPinEvents(
  db: Queryable,
  agentId: string,
  events: readonly PinEvent[]
): Promise<void> {
  for (const event of events) {
    if (event.action === "updated") {
      const bumped = await db.query(
        `UPDATE pin_events SET created_at = now(), label = $3
          WHERE id = (
            SELECT id FROM pin_events
             WHERE agent_id = $1 AND pin_id = $2
             ORDER BY created_at DESC, id DESC
             LIMIT 1
          )
          AND action = 'updated'
          AND created_at > now() - make_interval(secs => $4)`,
        [agentId, event.pinId, event.label, PIN_UPDATE_COALESCE_SECONDS]
      );
      if (bumped.rowCount) continue;
    }
    await db.query(
      `INSERT INTO pin_events (agent_id, pin_id, label, action)
       VALUES ($1, $2, $3, $4)`,
      [agentId, event.pinId, event.label, event.action]
    );
  }
}
