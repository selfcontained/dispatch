# Optional AI reply routing

AI routing is **Off** by default. When enabled it chooses the reply location before the first output block. Steering never moves existing output. The policy keeps primary work in the main conversation and uses threads for contained side questions. Explicit placement wins.

## Settings and credentials

Open **Settings → Agents → AI routing**. The checkbox enables routing. The access-token field shows a fixed mask when configured; it never reads the credential back. Edit replaces the mask with an empty password input and Save/Cancel actions. Test sends one synthetic request using the saved token; its result appears temporarily beside the field heading. Removing the token turns routing off and disables the checkbox until another token is saved.

The token is stored in the server's Postgres `settings` table without application-level encryption. Protect database access, disks, and backups. It is not put in browser storage, conversation prompts, diagnostic exports, or logs.

Production uses the database token and checkbox state. Environment tokens and mode flags do not override product Settings. For isolated development stacks (`DISPATCH_DEV_STACK=1`), `DISPATCH_DECISIONS_API_KEY` can seed the database token once when no token setting exists. A saved replacement wins. Removal writes an empty setting so a restart cannot silently restore the env token. Seeding a token does not enable routing.

Settings and connection checks require an authenticated session or the server bearer token in production, including first-run mode. A password-free isolated dev stack permits its normal browser Settings flow without an extra login. An existing dev password remains authoritative. Global browser-origin and portfolio boundaries still apply. Diagnostic export always requires the server bearer token.

The normal single-API-server deployment owns the in-memory settings cache. If multiple API processes intentionally share one DB, restart the other processes after a settings change. Shared reservations still enforce the fleet request cap.

`DISPATCH_ROUTING_SHADOW_DAILY_CAP` defaults to 25; integer values 0–100 are allowed and invalid caps fail closed at zero. UTC reservations persist across restarts and include failures/timeouts. Requests are not retried or redirected. A request cap is not a guaranteed dollar cap; provider project budgets remain separate.

## Decisions and evidence

The fixed endpoint is `https://api.openai.com/v1/decisions`, model `gpt-6-luna`, prompt version `root-first-side-threads-v3`. One choice question returns `initiating_discussion`, `home_root`, or `keep_existing_default`. Instructions are separate from untrusted JSON evidence. No arbitrary model-generated destinations are accepted.

Evidence contains up to four incoming user messages (1,000 UTF-16 units each), an authorized plain-text anchor (500 units), and up to three nearby authorized user/assistant messages from the same stream/discussion (500 units each). Assistant evidence is only this target agent's plain user-facing turn text. Structured answers, tool output, unrelated streams, attachments, files, repository contents, and session purpose are excluded. Attachment-bearing messages become a fixed placeholder. Serialized evidence is bounded at 8 KiB UTF-8, the HTTP request below 20 KiB, and response parsing at 16 KiB. Only allowlisted results are retained.

Only persisted ordinary user text addressed to the target agent qualifies. Internal/agent messages, awaited deliveries, invalid or mixed batches, structured answers, and steering do not classify. Explicit threads, source answer targets, and explicit root requests preserve placement. Overriding the default requires both the selected destination's probability and the API confidence score to reach 0.8. The three destination probabilities compare options; confidence is a separate decision score. Missing or uncertain values, keep-default, cap/concurrency rejection, timeout, or errors preserve the existing default.

A three-second total deadline covers configuration, evidence, reservation, provider response, and persistence. The validated destination is copied into the output block before first output. Late responses cannot mutate it. Cancellation and timeout diagnostics retain measured delay and frozen placement even when provider cleanup or reservation finishes late. Shadow-only internals remain available to the offline harness and historical diagnostics; Shadow is not a product Settings mode.

## Message metadata and realtime state

Routing details live on the initiating user message under **Message actions → Message metadata**. Delivery receipts and reply placement are separate sections; optional decision details show destination probabilities, confidence, and override thresholds. Routing API usage shows token/cache counts, latency, and estimated cost. Agent response blocks do not repeat routing diagnostics.

Diagnostics are fetched only when the metadata view opens, through a stream/block-scoped endpoint. Normal feed/thread reads do not query retained routing records. Metadata completion refreshes its own cache, not the feed/thread. Existing SSE handles lifecycle changes and reconnect invalidation; there is no feature polling. An initial metadata request spanning reconnect receives a follow-up refresh so an older response cannot hide a completed result.

Pending routing appears only after 500 ms in the same fixed-size receipt slot as steering/delivery checkmarks. It fades out on completion, cancellation, disconnect, or the bounded deadline. Routing takes priority while both states overlap; checkmarks then replace it in the same slot. Receipt rendering reads SSE cache state without HTTP requests or history timers. Delivery metadata retains available sent/pickup timestamps and distinguishes steering from a new prompt for newly recorded receipts.

## Diagnostic export and retention

`GET /api/v1/experiments/routing-shadow` requires the server bearer token. Agent-scoped MCP credentials and session-only access are insufficient. Global origin/portfolio boundaries still apply. Responses use `Cache-Control: no-store`.

JSON returns `records` and `nextBefore`; `format=jsonl` returns JSONL. At most 200 rows are ordered by decreasing signed turn ID; pass the last ID as `before` for the next page. Records retain IDs, frozen placement, explicit-routing label, model/prompt version, status, proposal, probabilities/confidence, timing, usage, and sanitized HTTP status. No copied conversation excerpts, credentials, or raw provider/error bodies are persisted.

Retention is fourteen days and approximately 2,000 newest records, with transient excess until cleanup. Cleanup runs hourly and before observation/export. Daily counters retain the current and two preceding days. Dedupe markers last as long as their turns. Conversation messages are not deleted by diagnostic retention.

## Estimated cost and validation

Standard nonregional Decisions rates verified 2026-11-08: uncached input USD0.10 per million, cached reads USD0.01 per million, default 30-minute cache writes USD0.125 per million; output is uncharged. Cached read/write counts are included in total input and subtracted before applying uncached rates. Valid historical usage without a cache breakdown uses an explicitly marked uncached-rate estimate. Malformed or missing token usage remains unpriced. Aggregates distinguish known subtotal and unpriced calls; empty spend is zero. Estimates are not billing.

Backend tests mock provider transport and use isolated Postgres. UI validation uses the served isolated preview; connection responses and pending SSE frames can be intercepted without paid calls. Full E2E runs in PR CI. The standalone `bun scripts/evaluate-routing.ts --live --limit 8` harness requires an explicit live flag and dedicated key, accepts a limit of 1–8, and never retries. Live execution needs its own authorized budget. Fixture accuracy is not an estimate of production routing quality.

References: [Decisions guide](https://developers.openai.com/api/docs/guides/decisions), [standard pricing](https://developers.openai.com/api/docs/pricing).
