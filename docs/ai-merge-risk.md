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
The latest record for a head is attached to the PR snapshot (`mergeRisk` on
`AgentPullRequest`) and survives the PR merging. A stale head (the GitHub read
and the checks observation disagree) is skipped without a provider call.

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
(severity, title, status, verification note); and the CI summary. Free text is
clipped first and the file list last when the payload is over budget. Raw
diffs, tool output, attachments, and credentials are never included. The
evidence is sent as `input_json` separated from the question instructions,
which tell the model the evidence is untrusted.

## Questions and gate

One request carries four questions (`merge-risk-v1`):

| name                       | type                                     | asks                                                    |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------- |
| `change_risk`              | score: low / moderate / high / critical  | blast radius of the change itself                       |
| `review_adequate`          | predicate                                | did reviews engage with the riskiest parts specifically |
| `description_matches_diff` | predicate                                | does the description account for the files that changed |
| `needs_human`              | choice: routine / human_review / abstain | the headline recommendation                             |

`assessMergeRisk` turns answers into a verdict. **human_review** needs a risk
score at or above the "high" level, or a `human_review` choice with
probability ≥ 0.5 — recommending a read is the cheap direction. **routine**
needs a `routine` choice with probability ≥ 0.8 and confidence ≥ 0.8 and a risk
score below "high". Anything else, including provider errors, abstains. These
thresholds are initial policy, not a measured accuracy guarantee.

The row badge shows "Routine" or "Read before merge"; abstentions show nothing
on the row but appear in the popover. The popover lists the level, the two
predicate probabilities, the human-review probability and confidence, the
head commit, and when it was assessed.

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
