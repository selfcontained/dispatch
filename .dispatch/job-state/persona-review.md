---
job: persona-review
updated_at: 2026-05-19
---

# persona-review — state handoff

Each run of the persona-review job reads this file at Phase 0 and overwrites it at Phase 6. It is the primary mechanism for passing context between runs so the job doesn't re-evaluate every persona from scratch every time.

## last_audited_sha

`unknown` — bootstrap state file; replace with the HEAD SHA at the start of the next completed run.

## personas

Per-persona tracking. Each entry records the last-known prompt state and assessment so future runs can detect changes and build on prior conclusions.

- No baselines recorded yet. The first run should populate this section by inventorying `.dispatch/personas/` and gathering review/feedback data.

## next_focus

Bootstrap the stateful workflow for this job:

- Inventory all persona files and record their current `prompt_sha`
- Gather 14 days of review and feedback data to establish baselines
- Produce an initial per-persona assessment and seed the backlog
- Identify the persona with the weakest signal as the first deep-dive target

## backlog

- Add the first concrete deferred items here after the next completed run.

## patterns

- No observations recorded yet. Populate with recurring themes about persona effectiveness after the first run.

## Notes for the next run

- Keep scope focused. Evaluate one or two personas deeply per run rather than skimming all of them.
- If a persona prompt changed since the last run, reset its evaluation window and note the limited sample size.
- Carry forward assessments for personas not in scope — don't drop them from the state file.

## history

- 2026-05-19: Bootstrapped the state file and prompt structure for the recurring persona-review job. No run-specific analysis recorded in this scaffold.
