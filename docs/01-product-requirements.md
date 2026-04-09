> **Note:** This document is a historical planning artifact. The MVP has been implemented and the product has evolved significantly beyond these original requirements — see the current codebase and [08-current-state-handoff.md](08-current-state-handoff.md) for authoritative behavior.

# Product Requirements (MVP)

## Problem

Managing multiple remote Codex CLI agents through raw SSH/tmux is workable but low-visibility. Terminal-only workflows are poor for reviewing high-quality iOS Simulator output, and there is no consolidated control plane for agent lifecycle.

## Users

- Primary: single operator managing many local/remote agents on a Mac host.
- Environment: Mac Studio/Mac mini, often accessed from another machine over Tailscale/VPN.

## Core User Stories

1. As an operator, I can create a new agent by selecting a working directory and optional simulator assignment.
2. As an operator, I can open a browser terminal for an existing agent and interact live.
3. As an operator, I can close my browser and reconnect later without stopping the agent.
4. As an operator, I can view all running/stopped agents and their status.
5. As an operator, I can stop an agent and clean up associated resources.
6. As an operator, I can view high-quality simulator screenshots for each agent in a dedicated media pane.

## Functional Requirements

- Agent creation with:
  - unique agent id
  - working directory validation
  - tmux session creation
  - Codex CLI launch command
- Agent list endpoint with status and metadata.
- Agent start/stop/restart operations.
- Terminal attach/detach in browser.
- Per-agent simulator allocation and release.
- Screenshot capture endpoint for allocated simulator.
- Persistence across backend restarts (restore agent registry, not necessarily process internals).

## Non-Functional Requirements

- Latency: terminal interaction should feel near-realtime (<250ms on LAN/VPN typical).
- Durability: metadata/state survives backend restart.
- Safety: no unauthenticated shell access.
- Simplicity: deployable on a single Mac host.

## Success Criteria

- Can run at least 3 concurrent agents with isolated simulator assignments.
- Browser reconnect to existing tmux session works reliably.
- Screenshot pane updates on demand and at periodic intervals.
- Agent lifecycle operations are deterministic and idempotent.
