# Optional thread-routing shadow experiment

This backend experiment observes ordinary user-triggered turns after their output placement has been frozen. It never changes routing, placement, delivery, streaming, authorization, or prompts sent to agent engines. No UI is included.

## Enable only in an isolated development environment

Set these environment variables on the isolated server, then restart it with the repository dev tools:

```sh
DISPATCH_ROUTING_SHADOW_ENABLED=1
DISPATCH_ROUTING_SHADOW_OPENAI_API_KEY=<dedicated project key>
DISPATCH_ROUTING_SHADOW_DAILY_CAP=25
```

Disabled is the default. Both the exact opt-in value `1` and a nonempty dedicated credential are required. The generic `OPENAI_API_KEY` is never used. Never put a credential in source, a command argument, an agent prompt, or a diagnostic export. Use an OpenAI project dedicated to this experiment and configure provider-side budgets as appropriate. Implementation and tests do not configure production or make paid requests.

The daily request cap defaults to 25; allowed integer values are 0 through 100. Invalid values fail closed at zero. Reservations are counted against the UTC date in Postgres before sending, including failed or timed out attempts. No retries occur. This is a request cap, **not a guaranteed dollar cap**. Provider token accounting, prices, and project access remain external concerns.

Unset the opt-in or set it to `0`, remove the dedicated credential, and restart to disable. Already in-flight calls finish within their timeout. Export and retention remain available while disabled.

## Exactly what leaves the server

The fixed endpoint is `https://api.openai.com/v1/decisions`, with model `gpt-6-luna`. One `choice` question uses fixed values `initiating_discussion`, `home_root`, and `keep_existing_default`. Instructions are separated from untrusted evidence in the question field.

Evidence is JSON containing up to four incoming user messages (1,000 UTF-16 code units each), an initiating anchor if it is plain user text addressed to this agent (500 code units), and up to three earlier plain user messages addressed to this agent in the same stream and discussion (500 characters each). Older context excludes replies to structured questions and forms. Evidence is further shortened until its serialized UTF-8 size is at most 8 KiB, including JSON escaping. The full request remains below 20 KiB. Attachment-bearing incoming messages are replaced with a fixed placeholder. Anchor and nearby attachment content are omitted. No attachment metadata, files, tool output, agent-authored messages, session purpose, repository content, or other streams are sent. Identifiers and existing placement are stored locally and are not included in provider evidence.

Only persisted user text addressed to the target agent qualifies. Internal messages, awaited deliveries, invalid/mixed batches, and replies to questions/forms are excluded. Steering does not call the turn-start hook. Explicit discussion examples remain authoritative in the application and are labeled `explicit_thread` for later analysis. The label describes the source discussion, not an inferred natural-language override.

## Bounds and failure behavior

Turn startup calls a fire-and-forget observer after inserting its output block. It does not wait for evidence queries or the provider. Postgres serializes reservation across server instances, with a maximum of two pending provider calls and no provider request queue. Global concurrency and daily-budget rejections are recorded as skipped. Evidence queries use the existing bounded server database pool. Calls time out after three seconds. Provider bodies are read up to 16 KiB, with only whitelisted fields parsed and retained. Network errors, malformed responses, refusals, HTTP errors, and timeouts remain diagnostic-only. Storage failures fail closed without logging evidence or credentials.

The durable marker on the original turn prevents duplicate observations across reconnects/restarts, including after a diagnostic record expires. A reservation is spent even if the server exits before sending. A crashed pending observation becomes `interrupted` during cleanup after ten seconds. Pending reservations are considered active for ten seconds, allowing crashed reservations to expire conservatively.

## Inspect and label examples

`GET /api/v1/experiments/routing-shadow` requires the existing **server bearer token**, including when the server is in passwordless first-run mode. Agent-scoped MCP credentials are not accepted. The global API authentication/origin/portfolio boundaries also apply. Browser session authentication alone is insufficient for this diagnostic endpoint.

```sh
curl -H "Authorization: Bearer $DISPATCH_SERVER_TOKEN" \
  "$ISOLATED_API_URL/api/v1/experiments/routing-shadow"
curl -H "Authorization: Bearer $DISPATCH_SERVER_TOKEN" \
  "$ISOLATED_API_URL/api/v1/experiments/routing-shadow?format=jsonl" > /tmp/routing-shadow.jsonl
```

Responses contain at most 200 records ordered by decreasing turn ID. JSON has `records` and `nextBefore`; pass the last turn ID as `before` for the next page. JSONL supports the same cursor. Exports are marked `Cache-Control: no-store`.

Records contain turn ID, agent ID, incoming message IDs, original frozen placement, explicit-thread label, creation time, model and prompt version (`thread-routing-v1`), status, proposed choice, available probabilities/confidence, latency, numeric token usage when reported, and HTTP status for provider errors. They contain no copied conversation excerpts, raw response/error bodies, or credentials. Use IDs with existing authorized message inspection to review examples, then label externally. No labeling UI or automated placement policy is included.

Diagnostics retain at most approximately 2,000 newest records (concurrent insertion may transiently exceed this until the next cleanup) and fourteen days. Cleanup runs hourly and before observation/export; expired rows can physically remain until the next cleanup while the server is stopped. Daily counters older than two days are deleted. Turn dedupe markers live as long as their turn rows. No original messages are deleted by retention. Exported files are the operator's responsibility.

## Validation and API reference

Tests use mocked fetch transport and isolated Postgres. They exercise the actual turn-start integration, unchanged placement despite a differing proposed choice, disabled/unconfigured mode, errors/refusals/malformed/oversized responses/timeouts, bounded context and authorization, dedupe after diagnostic deletion, concurrency reservations, durable daily caps, and authenticated JSONL export. No live API validation or model-quality/accuracy claim is made.

Official schema verified 2026-11-07: [Decisions guide](https://developers.openai.com/api/docs/guides/decisions) and [TypeScript create reference](https://developers.openai.com/api/reference/typescript/resources/decisions/methods/create). The request has `model`, `input`, and `questions`; a choice answer returns `choice` and `probabilities` (objects with `value` and `probability`), plus confidence. Provider schema/access can change; failures fall back to diagnostic statuses while real routing remains unchanged.
