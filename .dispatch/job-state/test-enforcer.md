---
job: test-enforcer
updated_at: 2026-05-16
---

# test-enforcer — state handoff

Each run of the test-enforcer job reads this file at Phase 0 and overwrites it during the state-file update step. It is the primary mechanism for passing context between runs so the job does not re-discover the same failures, flakes, and coverage gaps every time.

## last_audited_sha

`unknown` — bootstrap state file; replace with the HEAD SHA at the start of the next completed run.

## last_coverage_summary

- No committed baseline yet.
- This bootstrap file exists so future runs can record overall line / branch / function coverage and any meaningful deltas or notable weak spots.

## recent_flakes

- No curated flake list yet. Populate this section with local-only failures, intermittently failing tests, setup/cleanup leakage, and any useful hypotheses or fixes.

## next_focus

Bootstrap the stateful workflow for this job:

- verify that the current prompt is being followed end-to-end
- record the first real flake / coverage backlog after a completed run
- identify the highest-value next target once the local suite is green

## backlog

- Add the first concrete deferred reliability or coverage items here after the next completed run.

## Notes for the next run

- Keep the scope focused. If the suite is red, prioritize stability.
- If the suite is green, prefer one strong reliability or coverage improvement over many shallow additions.
- Record actual flaky behavior and coverage observations here instead of relying on memory.

## history

- 2026-05-16: Bootstrapped the state file and prompt structure for the recurring test-enforcer job. No run-specific fixes recorded in this scaffold.
