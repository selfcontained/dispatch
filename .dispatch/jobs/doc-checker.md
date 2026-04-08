---
name: Doc Checker
schedule: "0 9 * * 1"
timeout: 15m
needs_input_timeout: 18h
full_access: false
notify:
  on_complete:
    - slack
  on_error:
    - slack
  on_needs_input:
    - slack
---

# Doc Checker

Check documentation and configuration files for stale references. Run weekly.

## Important context

Dispatch is a general-purpose agent management platform that can be used with **any** repository. The docs, CLAUDE.md, job definitions, and persona files describe how to develop and operate **Dispatch itself** — they are NOT instructions for end-user repos. When verifying references, only check against the Dispatch codebase. Do not confuse Dispatch-the-service with the repositories that Dispatch manages.

## Scope

Check the following files for stale references:

1. **CLAUDE.md** (project root) — the primary developer instructions file
2. **docs/** — design docs and runbooks
3. **.dispatch/jobs/*.md** — job definitions (including this one)
4. **.dispatch/personas/*.md** — persona definitions

## What to check

For each file, look for references to:

- **File paths** — verify the referenced file/directory still exists at that path
- **Function/class names** — grep the codebase to confirm they exist
- **CLI commands** — verify referenced scripts and binaries exist (e.g., `dispatch-dev`, things in `bin/`, `package.json` scripts)
- **Environment variables** — check they're still referenced in code
- **Tool names** — verify MCP tools referenced in job/persona prompts are still registered
- **Package.json scripts** — verify referenced npm scripts still exist
- **Database tables/columns** — verify referenced schema objects exist in migration files
- **Internal contradictions** — flag instructions that conflict with each other across files

## What NOT to check

- External URLs (GitHub, npm, etc.) — these are outside our control
- Generic descriptions of how Dispatch works — only check concrete references
- Version numbers or dates — these are informational, not code references
- References to user-repo concepts (worktrees managed by the service, agent sessions) — these are runtime, not codebase references

## Procedure

1. Read CLAUDE.md and extract all concrete references (paths, commands, tool names, scripts).
2. Verify each reference against the current codebase using grep/glob.
3. Repeat for each file in `docs/`, `.dispatch/jobs/`, and `.dispatch/personas/`.
4. Compile findings into a report.

## Reporting

Use `job_log` to report progress as you work through each directory.

When complete, call `job_complete` with a report containing:

- **stale_references**: List of specific stale references found, each with:
  - `file`: the file containing the stale reference
  - `reference`: the stale reference text
  - `reason`: why it's stale (file not found, function renamed, etc.)
- **summary**: Total files checked, total references verified, total stale references found.

If nothing is stale, still call `job_complete` with an empty list and a summary confirming everything checked out.

Call `job_failed` only if you cannot read the files or access the codebase.
