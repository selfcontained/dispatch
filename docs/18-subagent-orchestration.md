# Subagent Orchestration

## Overview

Agents in Dispatch can currently launch personas for review-style tasks, but the spawning agent has no structured way to receive results, iterate on feedback, or coordinate multiple child agents working in parallel. Subagent orchestration gives a parent agent the ability to spawn child agents with specific tasks and communicate with them through MCP tools — enabling patterns like task decomposition, build-review loops, and specialist delegation.

## Concepts

### Parent and Child Agents

A **parent agent** spawns one or more **child agents** via an MCP tool. The parent stays alive and retains orchestration control: it decides when to spawn, what task each child works on, how to react to child output, and when the overall task is done.

A child agent is a full Dispatch agent (worktree, tmux session, MCP tools) with two additions:

1. It knows it was spawned by a parent (has a `parent_id`).
2. It has a `dispatch_report` MCP tool for sending structured results back to the parent.

Children are not aware of each other. Coordination happens through the parent.

### Lifecycle

Child agents follow the same lifecycle as standard agents (`creating → running → stopped`) with these behavioral differences:

- **Auto-cleanup**: When a child finishes its task, it reports its result and stops itself. The parent can also cancel a child explicitly.
- **Scoped lifetime**: Children are tied to the parent's session. If the parent is archived, its children are archived too.
- **No user prompting**: Children do not wait for user input. If they hit a blocker, they report it to the parent, not the user.

### Communication Model

Communication is asymmetric and structured:

- **Parent → Child**: The parent provides the task and context at spawn time. It can also send follow-up messages to a running child (e.g., "revise based on this feedback").
- **Child → Parent**: The child uses `dispatch_report` to send structured updates. Reports have a `type` field (`progress`, `result`, `blocked`) and a freeform `data` payload.
- **Notifications**: When a child sends a report, the parent receives a notification (interrupt-style, not polling) so it can react immediately.

## MCP Tool Interface

### Parent Tools

#### `dispatch_spawn_agent`

Creates and starts a child agent with a specific task.

```
Parameters:
  task: string          — The task description / prompt for the child
  context: string?      — Additional context (files, decisions, constraints)
  branch: string?       — Branch strategy: "inherit" (default), "new", "read-only"
  agent_type: string?   — "claude" (default), "codex", etc.
  timeout: number?      — Max duration in minutes before auto-cancel
```

Returns: `{ agent_id, status }` — the child's agent ID and initial status.

#### `dispatch_message_agent`

Sends a follow-up message to a running child agent.

```
Parameters:
  agent_id: string      — The child agent ID
  message: string       — The message content
```

Use cases: providing feedback on a child's intermediate result, redirecting scope, answering a child's question.

#### `dispatch_get_agent_result`

Retrieves the latest report(s) from a child agent.

```
Parameters:
  agent_id: string      — The child agent ID
  since: string?        — Only reports after this timestamp
```

Returns: `{ reports: [{ type, data, timestamp }], status }`.

#### `dispatch_cancel_agent`

Stops a child agent early.

```
Parameters:
  agent_id: string      — The child agent ID
  reason: string?       — Why the child is being cancelled
```

### Child Tools

#### `dispatch_report`

Sends a structured report to the parent agent.

```
Parameters:
  type: "progress" | "result" | "blocked"
  data: object          — Freeform structured payload
  summary: string       — Short human-readable summary
```

- `progress` — Intermediate update. The child continues working.
- `result` — Final output. The child should stop after sending this.
- `blocked` — The child cannot proceed and needs parent input.

## Use Cases

### 1. Task Decomposition

A parent receives a complex task ("implement these 4 API endpoints") and breaks it into independent subtasks. Each subtask is assigned to a child agent working in its own worktree. The parent waits for all children to report results, then merges or reconciles their work.

```
Parent receives task
  → Analyzes and decomposes into subtasks
  → spawn_agent(task_1), spawn_agent(task_2), spawn_agent(task_3)
  → Waits for results from all three
  → Merges branches, resolves conflicts
  → Runs validation suite
  → Reports completion
```

**Key benefit**: Parallelism. Four endpoints that take 15 minutes each sequentially take ~15 minutes in parallel.

**Key risk**: Merge conflicts when children edit overlapping files. The parent needs to be prepared to resolve or re-assign.

### 2. Build-Review Loop (Ralph Loop)

A parent orchestrates an iterative cycle: one child builds, another reviews, findings feed back into the next build iteration.

```
Parent receives feature request
  → spawn_agent(builder, task="implement feature X")
  → Receives builder result
  → spawn_agent(reviewer, task="review this diff", context=diff)
  → Receives review feedback
  → If issues found:
      → spawn_agent(builder, task="address feedback", context=feedback)
      → Loop until reviewer approves
  → Reports completion
```

**Key benefit**: Quality without user involvement in every iteration. The parent acts as the project manager.

**Variant**: The parent itself acts as the reviewer instead of spawning a separate child, saving an agent session.

### 3. Specialist Delegation

A parent agent is building a feature and recognizes it needs specialized input — security review, performance analysis, accessibility audit. It spawns a specialist child with narrow scope.

```
Parent is implementing auth changes
  → Reaches a point where security implications are unclear
  → spawn_agent(specialist, task="review auth token handling", context=relevant_files)
  → Receives specialist result
  → Incorporates recommendations
  → Continues with implementation
```

**Key benefit**: The parent doesn't need to be an expert in everything. It recognizes gaps and delegates.

### 4. Research → Implement Pipeline

Separates exploration from implementation to keep context windows clean.

```
Parent receives vague task
  → spawn_agent(researcher, task="explore codebase and produce implementation plan")
  → Receives structured plan (files to change, approach, risks)
  → Reviews plan, possibly adjusts
  → spawn_agent(implementer, task="implement this plan", context=plan)
  → Receives implementation
  → Validates
```

**Key benefit**: The implementer starts with a clean context and a clear plan, rather than a polluted context from exploration.

### 5. Validation Harness

A child agent acts as a dedicated tester while the parent writes code.

```
Parent is implementing a feature
  → spawn_agent(tester, task="test feature X via Playwright", branch="read-only")
  → Parent continues working
  → Receives test results (pass/fail, screenshots)
  → If failures: adjusts implementation, signals tester to re-run
  → Loop until tests pass
```

**Key benefit**: Tight feedback loop. Testing happens concurrently with development rather than as a separate phase.

## Design Considerations

### Depth and Breadth Limits

To prevent runaway spawning:

- **Max depth**: Children cannot spawn their own children (depth = 1) in v1. This can be relaxed later if there are clear use cases.
- **Max concurrent children**: A parent can have at most N active children (start with 4-6). Attempting to spawn beyond the limit returns an error.

### Branch Strategy

Children need isolation but the strategy depends on the use case:

- `inherit` — Child works on the parent's branch (or a sub-branch of it). Good for sequential work.
- `new` — Child gets a fresh branch off main. Good for parallel independent work.
- `read-only` — Child can read the codebase but cannot commit. Good for reviewers and researchers.

### Context Briefing Quality

The parent's briefing to the child is the single biggest factor in child success. The `dispatch_spawn_agent` tool should encourage structured context: what to do, what NOT to do, relevant files, constraints. Over time we could build templated briefing formats for common patterns (review, implement, test).

### Cost Awareness

Each child is a full agent session. Parents should be cost-aware — don't spawn a child for something that takes 30 seconds to do inline. The tool could surface estimated cost or token usage for completed children to help parents learn when delegation is worthwhile.

### Relationship to Personas

Personas are a specialization of this pattern: a child agent with a pre-defined role, review-focused scope, and the unified `dispatch_review_*` tools. Subagent orchestration is the general mechanism; personas could be re-implemented on top of it as a "spawn a child with this persona's system prompt and review tools."

### Relationship to Jobs

Jobs are user/schedule-triggered, top-level agent sessions. A job could use subagent orchestration internally — e.g., a nightly CI job that spawns children for parallel test suites. But jobs themselves are not children; they have no parent.

## Open Questions

1. **Should children share the parent's MCP server connections?** Or should each child establish its own? Sharing is cheaper but creates contention risks.

2. **How should the UI represent the parent-child relationship?** Nested in the sidebar? A dedicated orchestration view? Collapsible tree?

3. **What happens when a parent is stopped mid-orchestration?** Options: (a) children keep running, (b) children are paused, (c) children are cancelled. Probably (c) for v1 with an option for (a).

4. **Should there be a "dry run" mode?** Parent describes the decomposition plan and children to the user for approval before actually spawning anything. Useful for expensive orchestrations.

5. **How do we handle child worktree merging?** Automatic merge with conflict detection? Or require the parent to handle merges explicitly?
