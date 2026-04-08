---
name: Test Gap Finder
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

# Test Gap Finder

Identify recently changed code that lacks test coverage. Run weekly.

## Procedure

### 1. Gather recent changes

Run `git log --since="7 days ago" --name-only --pretty=format:""` on the `main` branch to get all files changed in the last week. Deduplicate the list and filter to only files that still exist.

Focus on source files:
- `apps/server/src/**/*.ts` — backend logic
- `apps/web/src/**/*.ts{x}` — frontend components
- `packages/shared/src/**/*.ts` — shared code

Ignore non-source files: configs, migrations, docs, tests themselves, CSS, static assets.

### 2. Classify changes

For each changed source file, read it and understand what changed (use `git diff main~20..main -- <file>` or similar to see the diff). Classify the change:

- **New file** — entirely new module/component
- **New endpoint/route** — a new API route was added
- **New component** — a new React component was added
- **New function/method** — significant new exported function
- **Bug fix** — change to existing logic
- **Refactor** — structural change without new behavior
- **Trivial** — type changes, renames, formatting (skip these)

### 3. Check for corresponding tests

For each non-trivial change, look for test coverage:

**Backend (apps/server/src/):**
- Check `apps/server/test/` for a corresponding test file
- Check `e2e/` for E2E tests that exercise the endpoint/feature
- For new API routes: grep E2E tests for the route path

**Frontend (apps/web/src/):**
- Check for component-level test files
- Check `e2e/` for E2E tests that interact with the component/page

**Shared (packages/shared/src/):**
- Check for unit tests alongside or in a test directory

### 4. Assess gaps

For each gap found, assess severity:

- **High** — new API endpoint with no E2E or unit test at all
- **High** — new business logic (data transformation, validation, state management) with no tests
- **Medium** — bug fix with no regression test
- **Medium** — new UI component with interactive behavior but no E2E coverage
- **Low** — new utility function with no unit test
- **None** — presentational component, type definition, or config change

Use judgment here. Not everything needs a test. A simple re-export or type alias doesn't need coverage. A new endpoint that handles payments does.

## Reporting

Use `job_log` to report progress as you work through the changed files.

Call `job_complete` with a report containing:

- **files_analyzed**: count of source files changed this week
- **gaps**: List of gaps found, each with:
  - `file`: the source file missing coverage
  - `change_type`: what kind of change (new endpoint, bug fix, etc.)
  - `severity`: high/medium/low
  - `suggestion`: what kind of test would help (E2E route test, unit test, etc.)
- **well_covered**: Notable changes that DO have good test coverage (positive signal)
- **summary**: Overall assessment — is the project's test discipline trending well or slipping?

If no source files changed in the last week, call `job_complete` noting that and skip analysis.
