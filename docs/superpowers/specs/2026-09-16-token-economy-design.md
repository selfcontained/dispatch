# Token economy: design

**Date:** 2026-09-16
**Status:** Approved, pending implementation plan
**Repo:** `selfcontained/dispatch`
**Branch:** `docs/token-economy-spec`

## What

Four changes that reduce tokens spent per Dispatch session, plus one deliberate
non-goal list. Three are infrastructure and ship on by default. One is a
user-selectable personality and ships off.

1. A built-in `economy` personality carrying a ponytail-derived solution ladder
   and a terseness rule.
2. `trimmed_guidance_enabled` defaults to on.
3. An audit of the 27 `dispatch_*` MCP tool descriptions.
4. Persona and subagent launches downshift to a cheaper model tier by default.

## Why the obvious approach does not work here

The harness does not own the Anthropic API loop. It spawns provider CLIs
(`claude-code-acp`, `codex`, `opencode`) as child processes and speaks Agent
Client Protocol over stdio (`apps/server/src/agents/harness/driver.ts`). Prompt
caching, `clear_tool_uses_20250919` context editing, and the
`compact-2026-01-12` server-side compaction beta are all parameters on a request
Dispatch never makes. They belong to the CLI. Adding them here is not a smaller
version of the work, it is impossible, and any plan that lists them is measuring
the wrong surface.

What Dispatch does own is text it injects into every session: the launch
guidance block, the personality prompt, and the MCP tool schemas. That is the
budget this spec spends.

## The one chokepoint

`buildLaunchGuidance` (`apps/server/src/agents/tmux/command-builder.ts:275`) is
the single source of injected guidance for both agent paths. tmux CLI agents
receive it through `--append-system-prompt`; harness agents receive it through
`buildHarnessPersona` (`apps/server/src/agents/harness/persona.ts:23`), which
calls the same function. Every change below lands once and reaches `claude`,
`codex`, `opencode`, `cursor`, and the harness.

## Personality, not persona

A persona in Dispatch is a reviewer. It carries `feedbackFormat: "findings"`,
has `apps/server/src/personas/review-diff.ts` behind it, and launches as a
separate agent against a completed diff. A persona can report that too much code
was written. It cannot cause less code to be written.

A personality shapes a working agent. The distinction is already documented in
the codebase, at `apps/server/src/shared/mcp/personality-tools.ts:40`:
"Personalities shape standard agents; they are unrelated to review personas."
Personalities are delivered as a second `--append-system-prompt`
(`apps/server/src/agents/tmux/command-builder.ts:621`) and folded into the
harness persona string, so one definition reaches every agent type.

Three constraints come with that choice, and each is a real cost rather than a
caveat:

| Constraint                       | Source                                              | Consequence                                                                                                                             |
| -------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PROMPT_MAX = 1000` chars        | `personality-tools.ts:9`                            | The ladder compresses to seven rungs plus the safety carve-out. The carve-out is not what gets cut.                                     |
| One active personality at a time | `getActivePersonality`, single `activeId`           | Selecting `economy` displaces whatever personality the user already runs. There is no composition, and this spec does not add one.      |
| No built-in personality concept  | Migration `0019_personalities.sql` stores rows only | Personas have `apps/server/src/personas/built-in.ts` with repo-file override. Personalities have nothing equivalent, so one gets added. |

Personalities are deliberately withheld from personas, job runs, and assisted
updates (`apps/server/src/agents/manager.ts:450`). The `economy` personality
therefore does not reach reviewers. Item 4 covers reviewer cost instead.

## 1. The built-in `economy` personality

Add a built-in layer for personalities mirroring `personas/built-in.ts`:
code-defined entries that appear in the list, can be selected, and are replaced
rather than shadowed by a user row of the same slug.

The prompt carries two rules inside the 1000-character cap.

**The ladder.** Adapted from `DietrichGebert/ponytail` (MIT). Before writing
code, stop at the first rung that holds: does this need to exist, is it already
in this codebase, does the stdlib do it, is it a native platform feature, is it
in an installed dependency, is it one line, and only then the minimum that
works.

**The carve-out, stated in the same prompt.** Trust-boundary validation,
data-loss handling, security, and accessibility are never on the chopping block.
Ponytail states this and it is the reason the ladder is safe to ship. Dropping
it to save characters converts a code-economy rule into a correctness hazard.

**Terseness.** One sentence covering prose length, aimed at Opus and Fable, whose
default register runs long in chat.

Ponytail is adapted rather than installed. Its distribution is per-agent plugins
and rule files, which reach only `PLUGIN_CAPABLE_AGENT_TYPES` and would need the
per-CLI adapters `buildLaunchGuidance` already abstracts away. Attribution goes
in the built-in definition.

## 2. `trimmed_guidance_enabled` defaults to on

The trimmed variant already exists, and the reasoning about what may drop and
what must not is written out at `command-builder.ts:242`. The detail it removes
is carried either by the MCP tool schema itself or by a plugin skill, and the
one rule with a demonstrated failure history, the `dispatch_share_file` nudge,
survives the trim on purpose. This is a default change, not new behavior.

Currently around 5,800 characters of guidance are assembled per session.

## 3. Tool description audit

27 `dispatch_*` tools are registered across 20 files in
`apps/server/src/shared/mcp/`. Every description enters the system prompt of
every session, on every turn, whether or not the flow is ever reached. Two
targets: text that restates launch guidance now that guidance is trimmed, and
procedural detail for flows most sessions never hit.

This is deletion. Nothing is added, and no tool is removed or renamed, so the
tool contract is unchanged.

## 4. Subtask model tiering

Persona reviews default to the parent's agent type and provider today, so an
Opus session spawns Opus reviewers. `dispatch_launch_persona` already accepts
`model` (`apps/server/src/shared/mcp/agent-launch-tools.ts:78`) and the tier
catalog exists (`apps/server/src/shared/agent-models.ts:47`), so the seam is
present.

Two halves, deliberately overlapping:

- A **resolver default**: a persona or subagent launch with no explicit `model`
  resolves to a cheaper tier within the same provider family. An explicit `model`
  always wins.
- A **guidance rule**: pick a lower tier for bounded subtasks unless the task
  needs the top model.

The default catches launches from agents that do not read the rule. The rule
catches launches the default cannot classify. Setting:
`subtask_model_downshift`.

## Validation

By feel, not by eval harness. No fixed task suite is built, and no A/B cohort
analysis is run. Token counts continue to be recorded through the existing
`usage-recorder.ts` and `provider-usage.ts` because that infrastructure is
already there, but nothing gates on them.

That choice puts the entire safety burden on reversibility, so it becomes a hard
constraint: every change above is independently revertible through its own
server setting, following the `apps/server/src/dispatch-harness-settings.ts`
pattern. A regression in output quality is diagnosed by turning one thing off,
which only works if no two changes share a switch.

The known risk is the one the research on this space keeps surfacing: token
counts improve while answer quality drops, and the drop is not visible in the
metric being watched. A March 2026 codebase-memory paper reported roughly 10x
fewer tokens alongside file-exploration accuracy falling from 92% to 83%.
Shipping by feel does not detect that. It is accepted here because the blast
radius is a prompt string behind a per-item switch, not a retrieval layer.

## Not doing

- **Prompt caching, context editing, server-side compaction.** Owned by the
  provider CLI. Track upstream.
- **Serena, Repomix, aider-style repo maps, code-graph MCP servers.** These are
  per-repo MCP configuration in `.dispatch/tools.json`, not Dispatch features.
  The published numbers are almost entirely maintainer self-reported, and the
  one independent benchmark on a 2,300-file repo found a graph tool using more
  context than plain grep and read while both reached the right answer. Revisit
  only with a measurement on this repo.
- **Composable personalities.** The single-slot conflict in item 1 is real and
  is accepted rather than solved. Unblocked by a schema change to
  `personalities` plus a merge order, neither of which this work needs.
- **Applying `economy` to reviewers.** Blocked by the deliberate exclusion at
  `manager.ts:450`. Item 4 addresses reviewer cost through price per token
  instead of through output length.

## Testing

Unit tests for guidance assembly across flag combinations, extending the
existing `command-builder` tests. Unit tests for built-in personality lookup and
user-row override, mirroring the persona built-in tests. Unit tests for the
model resolver, covering explicit `model` winning over the downshift. No E2E
work: none of this changes a UI path, except the personality picker gaining a
row.
