# Scheduled messages

Agents can use `schedule_message` to arrange a one-shot or bounded recurring message to themselves. This delivers into their existing conversation; it does not launch a Job or restart a stopped agent. Event-triggered delivery and user creation/editing forms are outside v1.

## Tools and limits

Creation accepts `title`, `message`, `deliver_at`, and optional `interval_seconds`, `stop_when`, `max_deliveries`, and `expires_at`. Timestamps require a timezone offset and are normalized to UTC. Recurrence requires completion criteria and an explicit count or deadline. Effective bounds are returned to the caller.

- Minimum interval: 60 seconds.
- Maximum lifetime: seven days from creation, including one-shots.
- Maximum accepted deliveries: 100; one-shots accept once.
- Maximum active, paused, or uncertain schedules: ten per agent.
- Title/message/criteria limits: 120/8,000/2,000 characters.

`list_scheduled_messages` returns a compact list; supplying an ID returns its complete details. `cancel_scheduled_message` stops future submissions. Supplying `completed: true` records that the purpose was fulfilled. Tools are scoped to the authenticated agent; scheduling for another agent is not supported.

## Delivery contract

Schedules and outstanding occurrences are stored in PostgreSQL. A one-second dispatcher finds due work. Cadence stays anchored to the first delivery time. Missed ticks collapse into one outstanding occurrence, including while offline, queued, or accepted but awaiting pickup. They never become a backlog of turns.

Scheduled messages have explicit runtime provenance and steering eligibility. They can enter an active turn without cancelling a tool. If steering is unsupported or declined, delivery waits for a later turn. Engine acceptance increments the delivery count; pickup or turn settlement releases the outstanding slot. The engine controls pickup timing, so tool return is not a guaranteed delivery boundary.

An AbortSignal removes queued work, and a runtime submission guard checks schedule status, deadline, and count immediately before submission. Once submission has begun, cancellation cannot promise recall. Engine-accepted content stays with the engine, even if cancellation or expiry happens before pickup. The expiry contract is no new submission after that time, not no reading after that time.

Definitively unsubmitted failures can retry with a short delay until expiry. Ambiguous submission failures suspend the schedule instead of risking a duplicate. On restart, pending occurrences survive; unresolved submitting or accepted occurrences become visibly uncertain. The user can cancel an uncertain schedule and create a replacement. Acceptance does not confirm pickup: the host can outlive a server restart with the reminder still queued. Clearing accepted outstanding state would release the coalescing gate and allow another reminder before the first is read. Suspending preserves that gate until pickup can be reconciled; this conservative recovery does not claim exactly-once engine execution.

Pause discards unaccepted pending work while retaining accepted content. Expiry keeps advancing. Resume uses the next future original cadence boundary; an overdue one-shot becomes immediately due. Explicit Stop, stopping a turn, or archive cancels schedules. Temporary unavailability alone does not restart an agent or cancel its schedules.

## UI

A yellow-accent clock beside the stream header settings cog opens a shadcn dialog in single and split layouts. It appears only for active, paused, or uncertain schedules; an inline count appears only for two or more. Ended records remain accessible from their stream actions. A shadcn Select dropdown chooses current and ended schedules on both desktop and mobile; desktop simply has a wider dialog. Backgrounds stay neutral. A compact clock-led delivery strip sits above the 14px reminder body. Stop condition and acceptance/expiry bounds are supporting lines, followed by pause/resume/cancel controls. Cancelling preserves the selected result even when the header trigger disappears; closing returns focus to the stable settings control. Dates show local timezone explicitly.

Creation produces a theme-accented Scheduled reminder card with a clock tile, compact heading, clear title, and compact metadata/action row that updates in place; actual submissions use a distinct Scheduled delivery treatment with the reminder body. Creation cards and delivered messages have a Manage schedule action. Delivery entries are clearly labelled scheduled content and use existing acceptance/pickup receipts. Collapsed ticks do not create stream entries. Scheduled entries cannot be manually retried through ordinary chat retry controls, which would bypass the scheduler's bounds.

Backend integration lives in `apps/server/src/scheduled-messages/`, MCP registration in `shared/mcp/scheduled-message-tools.ts`, and UI ownership in `scheduled-messages-button.tsx`. State is local to that feature; schedule data uses React Query.
