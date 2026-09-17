# Token economy: implementation plan

**Spec:** `docs/superpowers/specs/2026-09-16-token-economy-design.md`
**Date:** 2026-09-16
**Branch:** `agt_683b115bc1e9/dispatch-harness-research` (PR #1067)

## Spec review

The spec's code anchors were checked one by one against this branch and all of
them hold: `buildLaunchGuidance` at `command-builder.ts:275`, the personality
flag at `:621`, the trimmed-guidance reasoning at `:242`, `PROMPT_MAX = 1000`
and the personality/persona note at `personality-tools.ts:9` and `:40`, the
persona/job/assisted-update exclusion at `manager.ts:450`, the `model` parameter
at `agent-launch-tools.ts:78`, and the tier catalog at `agent-models.ts:47`.

The argument in "Why the obvious approach does not work here" is correct:
`agent-spec.ts` spawns provider CLIs and the driver speaks ACP over stdio, so
prompt caching and context editing are not parameters Dispatch can set. The
`reasoning_effort` option is likewise served by the CLI, not chosen here.

Two things the spec does not say that the code forces, both handled below:

1. **`activatePersonality` cannot activate a built-in.** It takes a `FOR UPDATE`
   row lock on `personalities`, so an id with no row activates nothing and
   silently returns false. A built-in needs its own activation path.
2. **The override rule is narrower than the persona one.** `createPersonality`
   assigns `randomUUID()`, so a user cannot create a row whose id collides with
   a built-in slug. Override-by-id is kept for parity and for seeded rows, and
   that limit is written down rather than implied.

Everything else is implementable as written.

## Item 1 — the built-in `economy` personality

New `apps/server/src/personalities/built-in.ts`, mirroring
`personas/built-in.ts`: a code-defined list of `Personality` values whose ids
are slugs, with `economy` the only member.

Three seams in `apps/server/src/db/personalities.ts`:

- `listPersonalities` returns built-ins ahead of user rows, dropping any
  built-in whose id a row already carries.
- `getPersonality` falls back to the built-in list on a row miss. This is the
  one that matters for launch: `getActivePersonality` reads through it, so both
  call sites in `manager.ts` pick the built-in up with no further change.
- `activatePersonality` short-circuits for a built-in id with no row and writes
  `active_personality_id` directly.

`updatePersonality` and `deletePersonality` stay row-only, so editing or
deleting a built-in is a 404 rather than a new failure mode.

The prompt carries the ponytail ladder, the safety carve-out and one terseness
sentence, inside 1000 characters. Attribution to `DietrichGebert/ponytail` (MIT)
goes in the definition's doc comment.

**Tests:** built-in lookup, user-row override, activation without a row,
and that `getActivePersonality` resolves a built-in.

## Item 2 — `trimmed_guidance_enabled` defaults to on

`launch-guidance-settings.ts:26` reads `=== "true"`, so an unset key is off.
Invert to treat unset as on (`!== "false"`), which flips the default without a
migration and leaves an explicit `false` honoured.

**Tests:** unset reads on; explicit `"false"` reads off; explicit `"true"` reads
on. Extend the existing `command-builder` guidance tests across the flag.

## Item 3 — tool description audit

Deletion only, across `apps/server/src/shared/mcp/`. Two targets named by the
spec: text restating launch guidance, and procedural detail for flows most
sessions never reach. No tool is added, removed or renamed, and no input schema
changes, so the tool contract holds.

Measure the assembled description bytes before and after and record both in the
commit body.

**Tests:** the existing MCP registration tests keep passing; add one asserting
the tool *names* are unchanged, so an audit cannot quietly drop a tool.

## Item 4 — subtask model downshift

New setting `subtask_model_downshift`, its own module on the
`dispatch-harness-settings.ts` pattern, default on.

Resolver: a persona or subagent launch with no explicit `model` resolves to a
cheaper tier inside the same provider family, using `agent-models.ts`. An
explicit `model` always wins — that is the case the test pins.

Guidance: one line in `buildLaunchGuidance` telling an agent to pick a lower
tier for bounded subtasks. It lands in both the full and trimmed variants,
because the trimmed variant is now the default.

**Tests:** explicit model wins; no model downshifts; downshift off leaves the
parent's model; an unknown family is left alone.

## Reversibility

The spec makes this a hard constraint, so each item gets its own switch and no
two share one:

| Item | Switch |
| ---- | ------ |
| 1 | Selecting a different personality, or none |
| 2 | `trimmed_guidance_enabled = false` |
| 3 | Revert the commit — this one is not a setting |
| 4 | `subtask_model_downshift = false` |

Item 3 is the exception and it is worth stating plainly: a description edit has
no runtime switch, so it is reverted by reverting its commit. It is kept as a
single self-contained commit for exactly that reason.

## Order

1, 2 and 4 are independent. 3 touches the most files and conflicts with nothing,
so it goes last. Each item is one commit.

## Validation

`pnpm run check:web`, the server vitest suite, and `pnpm run test:e2e`. No new
E2E is written: the only UI change is the personality picker gaining a row,
which the existing settings spec already covers.
