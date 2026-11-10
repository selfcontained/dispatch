# AI merge risk assessment

Settings → Agents → AI routing has a third control, **Merge risk assessment**,
beside reply routing and smart steering. It uses the same stored Decisions API
token; removing the token turns all three off. Merge risk defaults off.

The assessment answers one question for people: _should a maintainer read this
pull request before it merges?_ It is a recommendation shown on the agent's PR
row and in the PR details popover. It never merges, approves, blocks, enables
GitHub auto-merge, or changes any review state. The deterministic gates stay
where they are: CI must pass and findings must be resolved regardless of what
the model says. The model can only recommend a read; it cannot make a change
routine that the gates would reject.

## When a pull request is assessed

With the setting off (or no token stored) nothing runs: the assessor returns
before any query, GitHub read, or provider call, and no recommendation is
shown — including verdicts recorded while it was on, which reappear when it
is turned back on.

The PR refresher already polls GitHub for each tracked pull request. After an
observation with available checks it asks `MergeRiskAssessor` for a
recommendation. One provider request is made when all of these hold:

- the setting is on and a token is stored;
- the PR is **Open** (not draft, merged, or closed);
- the current head's checks are **passing**;
- every finding in reviews addressed to the agents tracking the PR is resolved;
- no record exists yet for this (PR, head commit, review state).

Records are keyed by PR URL, head SHA, and a fingerprint of the review state
(which reviewers posted and the status of each finding). A new commit or a
newly resolved review triggers a fresh assessment; an unchanged PR does not.
A stale head (the GitHub read and the checks observation disagree) is skipped
without a provider call.

A recommendation is shown only while the gate still holds for the current
observation. If checks are rerun and fail on the same head, a finding is
reopened, or a new review arrives with an open finding, the PR snapshot
(`mergeRisk` on `AgentPullRequest`) carries no recommendation until the gate
holds again; the stored record then returns without another request. Once the
PR has merged, the latest record for its head stays visible as history. The
refresher carries a previous same-head verdict forward only when the assessor
could not answer (checks unavailable or an error), never over a verdict the
assessor deliberately withheld.

`DISPATCH_MERGE_RISK_DAILY_CAP` bounds provider requests per UTC day (default
25, accepted range 0–100; invalid values fail closed to 0). A database lock
limits concurrency to two in-flight requests fleet-wide. Skipped reservations
leave the PR without a recommendation rather than retrying.

## Evidence

`buildMergeRiskEvidence` assembles a bounded JSON payload (12 KiB) from data
the server already holds: PR number, title, description, base/head refs, line
counts; the changed file list with per-file line counts and tags (migration,
test, docs, ci, deps, deleted); subsystems touched, derived from the checkout's
`.agents/owners.json` persona slugs; counts of uncovered files and non-test
lines; the launch briefing; every review's reviewer, summary, and findings
(severity, title, status, verification note); and the CI summary. When the
payload is over budget it shrinks in stages — free text first, then the file
list, then finding and review detail with explicit `omitted_findings`,
`omitted_open_findings`, and `omitted_reviews` counts — until it fits; the
structured counts and CI summary are never dropped, so the limit is a hard
bound. Raw diffs, tool output, attachments, and credentials are never
included. The
evidence is sent as `input_json` separated from the question instructions,
which tell the model the evidence is untrusted.

## Questions and gate

One request carries five questions (`merge-risk-v2`):

| name                       | type                                     | asks                                                                                   |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `change_risk`              | score: low / moderate / high / critical  | blast radius of the change itself (display only)                                       |
| `review_adequate`          | predicate                                | did reviews engage with the riskiest parts specifically                                |
| `description_matches_diff` | predicate                                | does the description account for the files that changed                                |
| `new_user_facing_surface`  | predicate                                | new or redesigned top-level surface, concept, website content, or external integration |
| `needs_human`              | choice: routine / human_review / abstain | the headline recommendation                                                            |

The headline question is framed around what reviewers cannot check: product
judgment. Reviewers and CI cover code correctness, so the maintainer reads
new or redesigned top-level surfaces, new external integrations, public
website content, and large multi-subsystem features; additions inside an
existing feature, persistence and migrations, release/CI plumbing, fixes,
hardening, and small UI adjustments are routine once reviewed.

`assessMergeRisk` turns answers into a verdict. **human_review** needs a
`human_review` choice with probability ≥ 0.5 — recommending a read is the
cheap direction. **routine** needs a `routine` choice with probability ≥ 0.8
and confidence ≥ 0.8. The risk score and predicates are shown but do not
override the choice. Anything else, including provider errors, abstains.

v1 (`merge-risk-v1`, kept in `scripts/evals/merge-risk-policies.ts` for
comparison) framed the question as blast radius and forced a read whenever the
score reached "high". Against the maintainer's first 35 grades it agreed on
9/24 development and 5/11 held-out PRs, flagging most migrations and release
work the maintainer considered routine. v2 agreed on 16/24 and 7/11 with no
false routines in either slice. These are small samples: the thresholds are
policy settings, not a measured accuracy guarantee, and further grades should
be collected from live use before loosening anything.

The row marker shows a green shield for routine and an amber one for read
before merge; abstentions show nothing on the row but appear in the popover.
The popover lists the level, the three predicate probabilities, the
human-review probability and confidence, the head commit, and when it was
assessed.

## Diagnostics and metrics

`merge_risk_decision_records` retains status, prompt version, verdict,
probabilities, latency, token usage, and sanitized HTTP status for 14 days and
at most 2,000 records. No evidence text, PR descriptions, or credentials are
persisted. Activity → Metrics shows attempts, routine / human review / abstain
counts, failures, latency, and estimated cost under **Merge risk**. Counts
describe verdicts, not whether they were right.

## Backfill and evaluation

The policy was first run against the repository's own history rather than
synthetic fixtures. `bun scripts/backfill-merge-risk.ts --database-url … --repo
owner/name --since YYYY-MM-DD` rebuilds the exact evidence payload for every PR
a Dispatch database has tracked, using a read-only Postgres session and `gh pr
view`. It makes no Decisions calls and writes fixtures only under `/tmp` with
mode 0600; fixtures contain PR and review text and must not be committed.

`bun scripts/evaluate-merge-risk.ts --fixtures /tmp/merge-risk-fixtures.json
--live` runs the current policy over those fixtures with the dev token from
`.env` (two workers, 20 s timeout, no retries) and writes results plus a
Markdown grading sheet under `/tmp`. Human labels go in
`scripts/evals/merge-risk-labels.json` keyed by PR number (`routine` or
`human_review`, optional `why`); the evaluator reports agreement, false
routines (labelled `human_review`, verdict `routine`), and missed human reviews
against them. Without `--live` the script prints a manifest and makes no
requests.

Historical merged PRs carry no negative label — everything that reached the
gates merged — so the first grading pass measures whether the model flags the
changes a maintainer would have wanted to read, not auto-merge precision.
Tune on a development slice and confirm once on held-out PRs; do not tune on
the held-out set after inspecting it.

References: [Decisions guide](https://developers.openai.com/api/docs/guides/decisions),
[AI steering](ai-steering.md), [AI reply routing](routing-shadow-experiment.md).

### Display lifecycle and historical context

The PR payload uses optional `MergeRiskSummary.displayState` to distinguish
display-only lifecycle data from a completed current assessment. When present,
`verdict` is an abstention placeholder and the UI must not render current
assessment metrics or an assessed timestamp. States cover setup/off, unavailable
PR data, eligibility waiting (PR lifecycle, CI, review), evaluating, budget and
capacity deferral, provider limits, and failure. A successful provider response
with an abstaining verdict remains a visible inconclusive result.

`previous` is a separately labeled completed assessment (including inconclusive
results) loaded from the latest successful record for the PR, potentially from a
different head or review state. Its head and timestamp belong to that historical
record. It is never current merge readiness. Disabled/no-key observations return
no history; an assessor exception cannot carry cached history forward. PR-data
fallbacks preserve the current display state rather than restoring old risk data.

An optional progress callback publishes evaluating after the existing reservation
succeeds and before evidence/provider work completes. It does not reserve a call,
change deduplication, or schedule retries. Review finding state changes mark the
owning agent's tracked PRs due in the existing coalesced, rate-limited queue.
The assessor still applies CI/review/settings gates and head/review-fingerprint
deduplication; resolving one of several open findings cannot authorize a call.

The development-only seeded-agent PR preview contains synthetic examples. It
does not exercise provider transport, and its lifecycle rows are illustrative.
User UX approval is required before merging this presentation change.

## Reading cached PR risk through MCP

`get_pull_request_risk({ agentId, url })` reads exactly one PR from an explicit
agent's existing inventory. URLs use the existing HTTPS GitHub PR canonicalizer.
The authenticated MCP caller can read itself, or an agent visible through the
existing repository/lineage listing that also shares its non-null project.
Unknown and unauthorized agents share one error. Invalid URLs, untracked PRs,
and unavailable tracking return tool errors; this tool never discovers PRs.

The response identifies its source as `cached_inventory`. `headSha` and
`checkedAt` describe the cached GitHub observation, not a live freshness claim.
`lifecycle` is the cached PR lifecycle. `state` preserves the risk display state
(disabled, waiting_ci, waiting_review, evaluating, deferred, capacity, daily_cap,
rate_limited, failure, unavailable, not_ready), or is absent, stale, current, or
inconclusive. Absent means there is no cached result, not that work was queued.
Only an open PR with a matching cached head and no display lifecycle override
can have `currentAssessment`; an abstention remains inconclusive. Historical
results are separately returned as `priorAssessment`. Assessment provenance
includes assessed head, time, provider status and prompt version. Metrics and
confidence are the existing display summary; private review content, raw prompts
and secrets are excluded. Disabled mode returns neither current nor historical
assessment. No result is merge approval (`mergeApproval` is always false).

Reads do not refresh inventory, schedule assessments, invoke providers, change
settings, merge or notify. No refresh control is accepted. This deliberately
cannot recover an assessment that the authoritative runtime inventory no longer
retains; it reports absent instead of performing a database or provider lookup.
