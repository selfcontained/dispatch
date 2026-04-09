> **Note:** This document is a historical planning artifact. Terminal reconnect recovery improvements have been implemented — see the current codebase for authoritative behavior.

# Tmux Reconnect Recovery Plan

## Problem Summary

Dispatch can take several seconds to recover terminal connectivity after the app returns from the background or when switching back to a long-lived session.

Live investigation on a clean tmux-backed dev stack showed the primary issue is not tmux attach latency. Fresh terminal attach is fast when the client knows it needs a new websocket. The visible delay comes from client-side reconnect coordination in `web/src/hooks/use-terminal.ts`.

## Observed Failure Modes

### 1. Resume before network recovery

When the app becomes visible before the browser/network stack is fully usable:

- `visibilitychange` triggers `ensureTerminalConnected()`
- `focus` also triggers `ensureTerminalConnected()`
- both issue preflight `GET /api/v1/agents/:id?includeGitContext=false`
- if those fetches fail, Dispatch immediately schedules reconnect retries with backoff
- when network recovers shortly after, Dispatch waits for the queued retry instead of reconnecting immediately

This is the most likely explanation for the normal "takes several seconds, then recovers" user experience.

### 2. Existing websocket can remain `OPEN` while unhealthy

During transient connectivity loss, the terminal websocket can remain `readyState === OPEN` for seconds even though terminal liveness is degraded.

The current reconnect path treats `OPEN` as sufficient to skip a real reconnect. That is too weak. Terminal heartbeats must be the authority for whether an existing websocket is healthy enough to reuse.

### 3. UI can remain in stale `reconnecting` state

If the client falls into reconnect mode and later reaches the "same agent + websocket still open" branch, the current code only calls `sendResize()` and returns. It does not explicitly restore:

- `connState = "connected"`
- `connectedAgentId`
- connected status text

That can leave the UI in a false reconnect state even after transport health returns.

### 4. Resume handlers duplicate work

Foreground recovery currently has overlapping triggers:

- `visibilitychange`
- `focus`
- reconnect timer callbacks
- manual attach

Without stronger coordination, those can overlap and produce duplicate:

- agent preflight fetches
- token requests
- state transitions

### 5. Token lifecycle can break reconnect recovery

Terminal websocket tokens are short-lived and single-use.

That means reconnect can fail even when the tmux session is still healthy if:

- a queued reconnect waits long enough for the issued token to expire
- duplicate reconnect attempts race and one attempt consumes the token first
- the app resumes from sleep/background with stale reconnect work still pending

The recovery plan must treat token invalidation as part of reconnect coordination, not as proof that the terminal session is gone.

## Non-Goals

- Do not change backend tmux attach behavior unless new evidence shows it is a meaningful source of latency.
- Do not add backend polling for terminal health when the websocket heartbeat already provides the needed signal.
- Do not couple terminal recovery to media refresh completion.

## Proposed Fix

## 1. Make heartbeat freshness the terminal liveness source of truth

Track on the client:

- `lastHeartbeatAt`
- `lastOutputAt`
- `lastHealthyAt`
- whether the current websocket is considered healthy enough to reuse

Rules:

- Do not treat `readyState === OPEN` by itself as proof of health.
- A newly opened websocket must count as fresh immediately, without waiting for the first heartbeat.
- Receiving terminal output should refresh liveness in the same way heartbeat does.
- If websocket is `OPEN` and recent liveness is within a freshness threshold, reuse it.
- If websocket is `OPEN` but liveness is stale, force-close it and perform a real reconnect.
- Evaluate heartbeat freshness on recovery triggers such as `visibilitychange`, `focus`, `online`, reconnect timer callbacks, and manual attach, rather than from a separate hidden-tab enforcement loop.
- Hidden/background timer throttling should not by itself force a disconnect while the app is not actively trying to recover.

Suggested starting threshold:

- stale after `> 25s`

This should be derived from the current 20s heartbeat interval with a small grace window. If heartbeat cadence is reduced later, the threshold should be recalibrated rather than hard-coded independently.

## 2. Add a single reconnect coordinator

Add a dedicated reconnect state machine in `use-terminal.ts` so only one reconnect attempt per target agent can be active at a time.

Requirements:

- maintain a per-target-agent in-flight guard for dedupe
- maintain a separate attach generation token / nonce for cancellation
- user-initiated attach to a different agent must preempt older attempts
- older timer callbacks must no-op once superseded
- `visibilitychange`, `focus`, retry timers, and manual attach must funnel through the same coordinator

The existing nonce mechanism is helpful but not sufficient by itself. The implementation should also prevent duplicate in-flight preflight fetches and duplicate token requests. Dedupe identity and cancellation generation should stay separate so repeated resume triggers for the same agent can coalesce cleanly while still allowing a newer user-initiated attach to supersede older work.

The coordinator should also own token lifecycle:

- a reconnect attempt should fetch at most one token for its active generation
- if a token is invalidated by delay or duplicate consumption, recovery should fetch a fresh token when the session still exists
- token invalidation during reconnect should not by itself clear attachment intent

## 3. Heal UI state when an existing websocket is still valid

If recovery succeeds via the existing websocket, explicitly restore connected UI state.

When reusing an existing healthy websocket for the same agent:

- set `connState` to `"connected"`
- set `connectedAgentId`
- set connected status text
- clear reconnect timer
- reset reconnect attempt count

This path should not rely on the websocket `open` event, because that event already happened.

## 4. Retry immediately on `online`

The current retry schedule is useful for repeated failures, but it is too slow once the browser reports connectivity again.

On `online`:

- clear any pending reconnect timer
- invalidate older reconnect attempts if needed
- immediately run the reconnect coordinator

This should reduce the common "network came back, but Dispatch waited for the 2.4s retry" case.

## 4a. Clarify retriable vs terminal attach failures

Reconnect behavior needs an explicit client/server contract for websocket attach failures.

Required behavior:

- invalid or expired terminal token should be treated as retriable during reconnect
- attach-time failures should distinguish "tmux session is gone" from transient attach/setup failure where a fresh token or immediate retry may succeed
- only confirmed session loss should clear terminal attachment intent and leave the UI detached

Client-side coordination is still the main fix, but this contract may require a small server-side follow-up if current websocket close codes are too coarse to support correct recovery behavior.

## 5. Collapse foreground resume triggers

Keep both `visibilitychange` and `focus` listeners if needed for cross-browser reliability, but route them through a very small dedupe window.

Suggested behavior:

- foreground resume requests within the same tick or short window should coalesce into one reconnect attempt
- if a reconnect attempt is already in flight for the same agent, later resume triggers should return early

## 6. Decouple terminal recovery from media refresh

Media refresh should not gate terminal reconnect.

If media fetch runs on the same resume path, it must remain independent. Terminal recovery should not wait for media fetch completion or share retry state with it.

## Implementation Notes

Likely client-side changes:

- `web/src/hooks/use-terminal.ts`
  - add heartbeat tracking
  - add reconnect coordinator / in-flight guard
  - update same-agent-open-socket branch to heal UI state
  - add `online` recovery handling
  - dedupe visibility/focus resume triggers
- optionally add a small helper module if the reconnect logic becomes easier to reason about outside the hook

Potential server-side changes:

- none required for the first client-side pass if the existing error contract proves sufficient during implementation
- if websocket close codes/messages are too coarse to separate retriable token/attach failures from real session loss, add a small follow-up to make those cases distinguishable

The server heartbeat already exists and should be sufficient for the first pass.

## Testing Plan

### Automated tests to add

Add coverage for the exact races observed during live validation.

#### Terminal reconnect tests

Extend `e2e/terminal-live.spec.ts` with cases for:

- reconnect after hidden websocket closes
- foreground resume where `visibilitychange` and `focus` fire together
- resume before network recovery, then online recovery
- healthy existing websocket resumes from `reconnecting` back to `connected` without opening a new websocket
- no duplicate token requests on a single resume
- expired token during reconnect fetches a fresh token and recovers
- duplicate resume triggers do not permanently fail reconnect by consuming the same token generation
- attach-time failure is retried when the tmux session still exists
- confirmed session loss exits reconnect cleanly without infinite retry

#### Visibility-aware tests

Extend `e2e/energy-visibility.spec.ts` or a new reconnect-specific spec for:

- hidden -> visible without disconnect should not cause unnecessary reattach
- stale heartbeat while websocket still reports `OPEN` should force real reconnect
- hidden-tab timer throttling does not by itself force disconnect while the app remains backgrounded

### Manual validation checklist

On a live tmux stack:

1. Attach to a running agent.
2. Background the app briefly, return while network remains healthy.
3. Background the app, disable network, foreground before network returns, then restore network.
4. Switch between two long-lived sessions repeatedly.
5. Confirm:
   - reconnect is immediate when websocket is already healthy
   - reconnect happens immediately on `online`
   - no duplicate attach/token activity
   - UI does not stay stuck on `reconnecting`
   - token-expiry or duplicate-token races do not strand a healthy tmux session

## Success Criteria

- Typical background/foreground recovery completes without visible multi-second delay once network is available.
- Foreground resume does not issue duplicate reconnect work for the same agent.
- Existing healthy websocket reuse restores connected UI state immediately.
- Stale `OPEN` websocket is detected from heartbeat age and replaced with a fresh connection.
- Session switching remains fast and stable.
- Token invalidation during reconnect does not strand a recoverable tmux session.

## Risks

### Over-eager reconnects

If heartbeat freshness threshold is too aggressive, Dispatch may reconnect unnecessarily during brief pauses.

Mitigation:

- choose a threshold above the heartbeat interval
- confirm behavior under normal idle sessions

### User-initiated switch races

A reconnect guard can accidentally block a real agent switch if keyed too broadly.

Mitigation:

- scope coordination by target agent id and attach nonce
- user-initiated attach to a new agent must preempt old work

### Hidden browser behavior differs by platform

Safari/PWA behavior may differ from Chromium.

Mitigation:

- keep resume triggers browser-tolerant
- rely on dedupe and heartbeat health instead of assuming one event model

## Recommended Order

1. Add heartbeat freshness tracking and connected-state healing for reused websocket.
2. Add reconnect coordinator and dedupe visibility/focus/manual/timer triggers.
3. Add immediate `online` retry behavior.
4. Add regression tests for delayed-resume and duplicate-trigger cases.
5. Re-run live validation against the tmux dev stack.
