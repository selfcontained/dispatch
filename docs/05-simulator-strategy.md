# Simulator Isolation Strategy

## Objectives

- One simulator assignment per active agent.
- Avoid accidental simulator sharing between agents.
- Make reservations deterministic and recoverable.

## Discovery

Use:

```bash
xcrun simctl list devices --json
```

Filter:

- `isAvailable == true`
- platform iOS

## Reservation Model

Table `simulator_reservations`:

- `udid` (primary key)
- `agent_id` (nullable when free)
- `status` (`free`, `reserved`, `error`)
- `updated_at`

## Allocation Algorithm (MVP)

1. Prefer booted but unreserved device.
2. Else choose shutdown unreserved device and boot it.
3. Mark reservation atomically in DB transaction.
4. Attach UDID to agent record.

## Boot / Shutdown Commands

Boot:

```bash
xcrun simctl boot <udid>
```

Shutdown on release (optional; may keep warm for fast reuse):

```bash
xcrun simctl shutdown <udid>
```

## Screenshot Capture

Capture fresh:

```bash
xcrun simctl io <udid> screenshot --type=png <path>
```

MVP recommendation:

- Keep last screenshot path per agent.
- Serve from cache if requested and recent (<3s old).

## Future: Live Media

- Option A: periodic screenshot push (simple, lower fidelity motion).
- Option B: `simctl io <udid> recordVideo` + transcode/stream pipeline (more complex, better UX).

## Failure Cases

- UDID becomes unavailable:
  - mark simulator reservation `error`
  - notify UI
  - allow manual reassign
- Capture failure:
  - return last cached image + warning metadata if available
