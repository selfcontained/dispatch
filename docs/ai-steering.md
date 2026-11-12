# AI message steering

Settings → Agents → AI routing has independent controls for reply placement and
message steering. Both use the stored Decisions API token. Removing it turns both
features off. Steering defaults off; there is no shadow mode.

When enabled, ordinary automatic user text arriving during a known active turn is
classified as `steer_current`, `queue_next`, or `keep_existing_default`. Relevant
corrections, evidence, constraints, and status questions can join the active turn,
including from another discussion. Independent requests wait for a subsequent
turn. Steering never moves the active turn's output destination or interrupts it.

Explicit Queue, Send now, and Interrupt retain priority. Images, commands,
structured answers, review findings, and scheduled messages keep their existing
delivery paths. Unsupported hosts and idle agents do not need classification.

Evidence includes up to eight validated user messages accepted into the active
turn, the incoming message, one recent assistant text excerpt from the active
discussion. Placement and default-delivery metadata are excluded to avoid biasing
the semantic choice. Attachment contents and tool logs
are excluded. The evidence is limited to 8 KiB; diagnostics retain no prompt text,
credentials, or raw provider errors.

The runtime holds the message visibly in its queue while classifying, outside the
submission lock. Decisions expire with their target turn. User queue controls can
override pending classification. Provider errors, timeouts, missing evidence, and
uncertain decisions preserve the existing delivery rules. An action requires both
choice probability and confidence of at least 0.8; this is an initial policy
threshold, not a measured accuracy guarantee. The total runtime wait is capped at
three seconds, with a provider timeout of 2.5 seconds.

Dispatch enforces no daily, call or token limit; spend limits belong to the API
key's own provider settings. A database lock limits provider concurrency to two
steering requests fleet-wide. Skipped reservations retain the default. In dev stacks, `DISPATCH_DECISIONS_API_KEY` seeds the shared
stored token once when absent; an explicitly removed token is not reseeded.

Activity → Metrics shows reply routing and steering separately: attempts, applied
choices, accepted steers, queued choices, defaults, failures, expirations, manual
overrides, provider latency, and estimated cost. The selected date range is limited
to retained diagnostics (14 days, at most 2,000 records per feature). Costs reuse
the routing estimator and explicitly identify unpriced calls. These counters
measure observed behavior, not decision quality. A queued choice records that the
runtime held the message for its current turn; it does not claim the next turn
completed. A steered choice records host acceptance, not confirmed agent pickup.

## Synthetic API evaluation

`bun scripts/evaluate-steering.ts` prints a dry-run manifest without making calls.
Use `--live --split development|holdout --policy baseline|candidate|current|both|ablations|final-pair`
with `--limit 1–120 --repeats 1–3 --out /tmp/results.json` for a bounded live batch.
The runner reads the dev token from `.env`, uses two workers, no retries, and a
2.5-second provider timeout. It does not touch application databases
or settings. Outputs contain synthetic fixtures and sanitized API results only.

Fixtures in `scripts/evals/steering-fixtures.ts` have fixed labels and a development/
holdout split. Each scenario has same-discussion and cross-discussion contexts.
The revised semantic payload omits both placement fields, so those paired requests
are deliberately identical; they are not independent observations. Repeat requests
are a stability check, not additional independent examples. Score raw choices,
choices after the shared runtime gate, and final delivery after fallback separately.
Report incorrect applied choices and missed actions as well as accuracy. Synthetic
labels encode the chosen product policy and do not establish production accuracy.

For a check of deployed behavior, use `--policy current`; it uses the deployed
prompt and semantic payload. `baseline` freezes v1 with placement metadata;
`candidate` is the first expanded development prompt with metadata. `ablations`
compares expanded/compact prompts with and without metadata. `final-pair` compares
the original baseline against the selected expanded semantic version. Do not tune
on the holdout split after inspecting its results.
