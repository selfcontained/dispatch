# Personas and Feedback

## Overview

Personas are reusable agent roles that review work from a specific perspective. When launched, a persona runs as a child agent that analyzes the current branch's changes and submits structured feedback findings. This enables automated code review, security audits, UX reviews, and testing without manual setup.

## How Personas Work

1. A parent agent (or the user via the UI) calls `dispatch_launch_persona` with a persona slug and context briefing.
2. Dispatch loads the persona definition from `.dispatch/personas/{slug}.md` in the repo.
3. A new child agent is spawned with:
   - The persona's instructions as its system prompt
   - A git diff of the current branch vs main injected via `{{diff}}` placeholder
   - The caller's context briefing injected via `{{context}}` placeholder
   - The same agent type and full-access setting as the parent
4. The child agent reviews the work and submits findings via `dispatch_feedback`.
5. Findings appear in the parent agent's Feedback panel in the UI.

## Defining Personas

Each repo defines its own personas as markdown files in `.dispatch/personas/`. There are no built-in personas — every repo creates the roles that make sense for its workflow (e.g., security review, UX review, architecture review, testing).

Persona files use markdown with YAML frontmatter:

```yaml
---
name: Security Review
description: Reviews code for security vulnerabilities
feedbackFormat: findings
---

You are a security reviewer. Analyze the following changes
for vulnerabilities, injection risks, and auth issues.

## Context
{{context}}

## Diff
{{diff}}

For each issue found, use the dispatch_feedback tool to submit
a finding with appropriate severity, file path, and suggestion.
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Display name shown in the UI |
| `description` | Yes | Short description of the persona's purpose |
| `feedbackFormat` | No | Hint for feedback structure (default: `findings`) |

### Template Placeholders

| Placeholder | Replaced With |
|-------------|---------------|
| `{{context}}` | The context briefing provided by the caller |
| `{{diff}}` | Git diff of the current branch vs the base branch |

## Feedback System

### Submitting Feedback

Agents submit findings via the `dispatch_feedback` MCP tool:

```json
{
  "severity": "high",
  "filePath": "src/auth/middleware.ts",
  "lineNumber": 42,
  "description": "Session token is stored in localStorage, vulnerable to XSS",
  "suggestion": "Use httpOnly cookies for session storage",
  "mediaRef": "screenshot-xss-demo.png"
}
```

### Feedback Fields

| Field | Required | Description |
|-------|----------|-------------|
| `severity` | No | `critical`, `high`, `medium`, `low`, or `info` (default: `info`) |
| `filePath` | No | File path relative to repo root |
| `lineNumber` | No | Line number in the file |
| `description` | Yes | What was found — the issue or observation |
| `suggestion` | No | Suggested fix or action |
| `mediaRef` | No | Filename of previously shared media to attach |

### Feedback Status

Each finding has a status that can be updated from the UI:

| Status | Meaning |
|--------|---------|
| `open` | New finding, not yet reviewed |
| `fixed` | Issue has been addressed |
| `dismissed` | Finding was reviewed and dismissed |
| `forwarded` | Sent to another agent or process |
| `ignored` | Intentionally not addressing |

### Viewing Feedback

- Open an agent's Feedback panel from the sidebar to see findings from its persona children.
- Findings are grouped by severity and show file references as clickable links.
- Use `scope=children` on the API to aggregate feedback from all child persona agents.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/personas` | List available personas (requires `cwd` query param) |
| GET | `/api/v1/agents/:id/feedback` | Get feedback for an agent (`scope=children` for child feedback) |
| PATCH | `/api/v1/agents/:id/feedback/:feedbackId` | Update feedback status |
