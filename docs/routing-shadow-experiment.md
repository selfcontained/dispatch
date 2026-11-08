# Optional AI thread routing

The experiment has three modes: **Off** (default, no automatic requests), **Shadow** (asynchronous suggestions without changing output), and **Active** (a bounded decision before the first output block). Steering never moves existing output. No production configuration is changed by implementation or validation.

## Product Settings and credentials

Open **Settings → Agents → AI thread routing**. Save, replace, or remove a dedicated OpenAI project key; select Off, Shadow, or Active. A key alone does not enable routing. No credential is returned to the browser after saving. The password field clears on success. Configured status indicates whether the effective credential comes from Settings or the environment.

Following existing integration-settings conventions, the saved credential is a server-side Postgres `settings` value, **without application-level encryption**. Protect DB access, disks, and backups. It is not placed in browser storage, conversation prompts, diagnostic exports, or logs. Requests use the existing API authentication and origin/portfolio boundaries (including the app's existing passwordless first-run behavior). Set a password and use HTTPS on shared networks. Removing a saved key leaves any environment credential in effect.

Server environment alternatives:

```sh
DISPATCH_ROUTING_MODE=off # off | shadow | active
DISPATCH_DECISIONS_API_KEY=<dedicated project key>
DISPATCH_ROUTING_SHADOW_DAILY_CAP=25
```

Explicit environment mode overrides the product selector; the UI displays the override and disables that selector. A nonempty environment key overrides the saved key. Without environment overrides, persisted Settings apply immediately to new turns and survive restarts. The legacy `DISPATCH_ROUTING_SHADOW_ENABLED=1` flag remains a shadow-mode alias only when `DISPATCH_ROUTING_MODE` is absent. Invalid modes fail closed to Off. The earlier experimental credential name is not used.

The daily cap defaults to 25; integer values 0–100 are allowed. Invalid caps fail closed at zero. UTC daily reservations persist in Postgres across restarts and include failures/timeouts. No retry or redirect occurs. A request cap is **not a guaranteed dollar cap**; use a dedicated OpenAI project and appropriate provider budgets.

Disable with Off in Settings, or `DISPATCH_ROUTING_MODE=off` and restart when using an environment override. To stop all configured requests, also remove saved and environment credentials. Already running requests finish or time out; steering/output never moves.

## Decisions and evidence

The fixed endpoint is `https://api.openai.com/v1/decisions`, model `gpt-6-luna`, prompt version `thread-routing-v2`. One choice question returns `initiating_discussion`, `home_root`, or `keep_existing_default`. Instructions are separate from untrusted JSON evidence. No IDs or arbitrary model-generated destinations are accepted from the provider.

Evidence contains up to four incoming user messages (1,000 UTF-16 units each), an available authorized plain-text anchor (500 units), and up to three nearby authorized user/assistant messages from that same stream/discussion (500 characters each). Assistant evidence is only this target agent's plain user-facing turn text, labeled by role. Structured question/form answers, tool output, unrelated streams, attachments, files, repository contents, and session purpose are excluded. Attachment-bearing incoming messages become a fixed placeholder. Serialized evidence is shortened to at most 8 KiB UTF-8 including escaping; the complete HTTP request stays below 20 KiB. Response parsing is capped at 16 KiB and only whitelisted values are retained.

Only persisted ordinary user text addressed to this agent qualifies. Internal/agent messages, awaited deliveries, invalid/mixed batches, question/form answers, and steering do not classify. A root user's own post supplies the initiating-discussion candidate. Existing explicit threads, source answer targets, and clear explicit home-root requests retain existing placement. Active mode requires both selected-choice probability and confidence at least 0.8. Missing/uncertain values, keep-default, cap/concurrency rejection, timeout, or errors fall back to existing behavior.

Active mode has a three-second total deadline around configuration lookup, authorized evidence, DB reservation, provider response, and diagnostic persistence. The chosen validated destination is copied into the output block before first output. Late responses cannot mutate it. Settings are primed at startup and refreshed on save so shadow observation does not wait on a Settings DB query at turn start. User envelopes defer to the server-frozen active location (`get_conversation_context`) rather than asserting a conflicting home/thread destination.

There are at most two pending provider reservations across server instances, with no waiting provider queue. Skipped reservations are recorded. A durable marker on the original turn prevents duplicate calls even after diagnostics expire. Reservations remain spent on crashes; stale pending records become interrupted after ten seconds. Storage failures fail closed without logging evidence or credentials.

## Connection check, pending indicator, and synthetic evaluation

**Check connection** explicitly sends one fixed synthetic conversation, including while Off. It never sends production messages, changes mode, or enables automatic routing. It shares the persistent daily budget and concurrency cap and returns only sanitized status, choice, timing, and numeric usage. Synthetic diagnostic IDs are negative; real turn IDs are positive.

During an actual eligible Active decision, the affected conversation polls narrowly scoped pending state. A small accessible sparkle appears after about 300 ms of observed pending state, without visible text or layout shift; fast calls remain invisible. Reduced motion uses a static icon. Completion, fallback, error, timeout, cancellation, unmount, or reconnect clears/reconciles the state. Shadow mode never displays it. No artificial minimum delay is added.

A standalone harness uses eight fixed synthetic conversations with expected labels, measures accuracy/latency/usage/failures, and makes no request without both the credential and explicit `--live`:

```sh
bun scripts/evaluate-routing.ts --live --limit 8
```

`--limit` must be 1–8. Calls are sequential and never retried; output contains no secret/raw provider bodies. This harness is independent of the app DB/request counter, so its caller must honor the separately authorized evaluation budget. Parent owns live execution. The initial authorization covers at most twelve total requests; the parent's connectivity smoke consumed one, leaving eleven before final evaluation. Do not run the same paid batch in both worktrees. Synthetic accuracy is a fixture result, not an estimate of production routing quality.

## Inspect diagnostics

`GET /api/v1/experiments/routing-shadow` requires the existing **server bearer token**, including passwordless first-run mode. Agent-scoped MCP credentials and session-only access are insufficient for export. Global origin/portfolio boundaries still apply.

```sh
curl -H "Authorization: Bearer $DISPATCH_SERVER_TOKEN" \
  "$ISOLATED_API_URL/api/v1/experiments/routing-shadow"
curl -H "Authorization: Bearer $DISPATCH_SERVER_TOKEN" \
  "$ISOLATED_API_URL/api/v1/experiments/routing-shadow?format=jsonl" > /tmp/routing-results.jsonl
```

JSON has `records` and `nextBefore`. At most 200 rows are ordered by decreasing signed turn ID; pass the last ID as `before` for the next page. JSONL accepts the same cursor. Responses use `Cache-Control: no-store`.

Records include turn/agent/message IDs, original frozen default placement, explicit-routing label, timestamp, mode, model/prompt version, status, proposal, available probabilities/confidence, latency, usage when reported, and sanitized HTTP status. No copied conversation excerpts, credentials, or raw provider/error bodies are persisted. Use IDs with existing authorized message inspection and label examples externally.

Retention is fourteen days and approximately 2,000 newest records, with transient excess until concurrent/later cleanup. Cleanup runs hourly and before observation/export. Rows can physically remain until cleanup after a stopped server restarts. Old daily counters retain only the current and two preceding days. Dedupe markers last as long as their original turns. Original conversation messages are never deleted by experiment retention; exported files are the operator's responsibility.

## Verification

Backend tests mock provider transport and use isolated Postgres, including active/root placement, unchanged explicit discussions, uncertainty/deadline/late responses, shadow behavior, secret masking/persistence/precedence, caps/dedupe/retention, and synthetic checks. UI validation uses served desktop/mobile Settings with synthetic intercepted check/pending responses; no paid calls are needed for that validation. Live results are reported separately by the parent.

Official schema verified 2026-11-07: [Decisions guide](https://developers.openai.com/api/docs/guides/decisions). The request has `model`, `input`, and `questions`; a choice answer returns `choice`, a `probabilities` array of `{value, probability}`, and confidence. Parent's separately authorized one-request smoke confirmed HTTP 200 and schema compatibility; that is connectivity evidence, not integrated app validation.
