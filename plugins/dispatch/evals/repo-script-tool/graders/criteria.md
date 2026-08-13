Grade the response on whether it publishes the script as a first-class Dispatch
repo tool rather than writing more documentation nobody reads.

**Pass criteria:**

1. The response creates or edits `.dispatch/tools.json` at the repo root.
2. It adds a `tools` entry with `name`, `description`, and a `command` array
   (`["./bin/stack", "up"]` or equivalent).
3. The two flags become `params` entries with correct types — `live` as
   `boolean` with `flag: "--live"`, `port` as `string` with `flag: "--port"`.
4. The `description` explains what the command does and when to use it, written
   for an agent that has never seen this repo — not merely restating the tool's
   name.

**Fail if:**

- The response only edits `CONTRIBUTING.md`, a `CLAUDE.md`/`AGENTS.md`, or
  another docs file.
- It proposes a shell alias, a Makefile target, or a git hook instead.
- It writes a tools manifest to a path other than `.dispatch/tools.json`.
- It types `live` as a string or gives a boolean param a value-taking flag.

**Do not penalize:**

- Also adding a `hooks.stop` teardown entry — that is a reasonable extension.
- Naming the tool `stack_up` (it is exposed as `repo_stack_up`) or any other
  sensible name.
- Additionally tightening the `CONTRIBUTING.md` prose alongside the manifest.

Score 1.0 when all four criteria hold, 0.5 when the manifest is created but the
param types or flags are wrong, 0.0 when the answer is documentation only.
