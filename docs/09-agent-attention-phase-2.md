> **Note:** This document is a historical planning artifact. Agent attention is now driven by the `dispatch_event` MCP tool with status events (working, blocked, waiting_user, done, idle) — see the current codebase for authoritative behavior.

# Agent Attention Phase 2 Plan

This doc describes how to expand Dispatch agent attention from the current narrow error-state signal into a backend-backed attention model that can represent detached activity and richer Dispatch-owned events without changing the UI contract.

## Current Phase 1 Scope

Today the sidebar attention indicator is intentionally conservative.

It only reflects:
- backend-reported agent error state
- optional `lastError` text already returned by the agent API

This means phase 1 is honest but limited:
- it does not depend on terminal bells
- it does not infer response completion
- it does not detect detached tmux activity
- it does not yet model app-level events like approval requests or waiting-for-user-input

## Goal

Keep the phase 1 UX contract stable while broadening the signal sources underneath it.

The phase 2 system should preserve:
- separate connection state (`Active`, `Detached`)
- a distinct attention indicator
- stable clear semantics

The improvement should be fidelity, not a product redesign.

## Target Attention Sources

Phase 2 should support multiple backend-owned sources:

- `error`
  - agent process failed to start, crashed, or hit a lifecycle error
- `approval_required`
  - Dispatch learns the agent is blocked on approval
- `input_required`
  - Dispatch learns the agent is waiting for user input
- `detached_activity`
  - tmux reports meaningful background activity for an unattached agent
- `response_complete`
  - a higher-level Dispatch conversation/event layer reports the agent finished a response while detached

Not all of these exist in the repo today. This plan defines how to add them without changing the rendered UX.

## Recommended Data Model

Add attention fields to the `agents` table:

- `attention_state TEXT`
- `attention_source TEXT`
- `attention_message TEXT`
- `attention_updated_at TIMESTAMPTZ`

Example values:
- `attention_state`: `none`, `needs_attention`
- `attention_source`: `error`, `approval_required`, `input_required`, `detached_activity`, `response_complete`
- `attention_message`: human-readable detail like an error summary

This keeps the frontend simple:
- connection state remains frontend-derived
- attention state becomes API-backed

## API Contract

Extend:
- `GET /api/v1/agents`
- `GET /api/v1/agents/:id`

with:

```json
{
  "attentionState": "needs_attention",
  "attentionSource": "approval_required",
  "attentionMessage": "Agent is waiting for approval.",
  "attentionUpdatedAt": "2026-03-08T12:00:00Z"
}
```

Add mutation paths for clearing or setting attention if needed:
- `POST /api/v1/agents/:id/attention`
- `POST /api/v1/agents/:id/attention/clear`

## Backend Responsibilities

### 1. Persist attention

The API should own attention as durable state, not as a browser-local heuristic.

This enables:
- consistent UI across browser sessions
- attention that survives refresh
- detached-session monitoring

### 2. Reconcile tmux-backed background signals

For detached agents, the backend should monitor tmux independently of browser attachment.

Candidate mechanisms:
- enable `monitor-activity`
- inspect tmux window flags via `list-windows`
- inspect pane/window metadata via `display-message`
- optionally use tmux hooks if a clean hook workflow is available

The implementation should prefer explicit tmux metadata over parsing human-readable pane text.

### 3. Accept richer Dispatch-owned events

If Dispatch grows a higher-level conversation/event layer, that layer should emit explicit attention-worthy events instead of forcing the terminal to be the source of truth.

Examples:
- agent finished a response while detached
- agent requested approval
- agent requested user input

These are the signals most aligned with how users think about “something needs my attention.”

## Clear Semantics

The UI should continue to clear attention when the user intentionally returns to the agent.

Recommended clear events:
- selecting the agent in the sidebar
- attaching to the agent terminal
- explicit dismiss action if one is added later

Clearing should be an API mutation so multiple clients remain consistent.

## Implementation Order

1. Add persistent attention fields to the database and API shape.
2. Populate attention from existing backend error state.
3. Add explicit clear semantics via API mutation.
4. Add tmux-backed detached activity monitoring.
5. Add higher-level Dispatch attention sources when the product exposes them.

## Risks

- tmux activity can be noisy and may need thresholds.
- multiple attention sources can race unless the merge policy is explicit.
- a future conversation/event layer may want finer-grained states than a simple boolean.

## Success Criteria

Phase 2 is successful when:
- attention is API-backed and survives reloads
- detached agents can raise attention without an attached browser terminal
- multiple browser sessions see the same attention state
- the sidebar UX introduced in phase 1 does not need to change
