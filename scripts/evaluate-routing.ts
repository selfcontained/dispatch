import {
  estimateRoutingUsd,
  summarizeRouting,
} from "../apps/server/src/chat/routing-metrics.js";
/** Opt-in synthetic Decisions evaluation. No database, production messages, retries, or secret output. */
import "dotenv/config";
import {
  requestRoutingDecision,
  SHADOW_MODEL,
  SHADOW_PROMPT_VERSION,
} from "../apps/server/src/chat/routing-shadow.js";
import { ROUTING_EVAL_FIXTURES as fixtures } from "../apps/server/src/chat/routing-policy.js";
const args = process.argv.slice(2);
const position = args.indexOf("--limit");
const offsetPosition = args.indexOf("--offset");
const offset = offsetPosition >= 0 ? Number(args[offsetPosition + 1]) : 0;
const limit =
  position >= 0 ? Number(args[position + 1]) : Math.min(8, fixtures.length);
if (
  !args.includes("--live") ||
  !process.env.DISPATCH_DECISIONS_API_KEY?.trim() ||
  !Number.isInteger(offset) ||
  offset < 0 ||
  offset >= fixtures.length ||
  !Number.isInteger(limit) ||
  limit < 1 ||
  limit > Math.min(8, fixtures.length)
) {
  process.stdout.write(
    "No requests made. Set DISPATCH_DECISIONS_API_KEY and run bun scripts/evaluate-routing.ts --live --limit N (1–8) [--offset N]. Parent owns the authorized live batch.\n"
  );
  process.exitCode = 1;
} else {
  const results = [];
  for (const fixture of fixtures.slice(offset, offset + limit)) {
    const response = await requestRoutingDecision(
      process.env.DISPATCH_DECISIONS_API_KEY.trim(),
      JSON.stringify({
        incoming: [fixture.incoming],
        anchor: fixture.anchor,
        nearby: fixture.nearby,
        hasInitiatingDiscussion: true,
        currentLocation: fixture.currentLocation ?? "home_root",
      })
    );
    const result = response.result as {
      choice?: string;
      latencyMs: number;
      usage?: unknown;
      confidence?: number;
      probabilities?: { value: string; probability: number }[];
    };
    const currentLocation = fixture.currentLocation ?? "home_root";
    const certain =
      typeof result.confidence === "number" &&
      result.confidence >= 0.8 &&
      result.probabilities?.some(
        (p) => p.value === result.choice && p.probability >= 0.8
      );
    const actualLocation =
      response.status === "ok" &&
      certain &&
      result.choice !== "keep_existing_default"
        ? result.choice === "initiating_discussion"
          ? "thread"
          : "home_root"
        : currentLocation;
    const expectedLocation =
      fixture.expected === "keep_existing_default"
        ? currentLocation
        : fixture.expected === "initiating_discussion"
          ? "thread"
          : "home_root";
    results.push({
      name: fixture.name,
      expected: fixture.expected,
      currentLocation,
      expectedLocation,
      actualLocation,
      placementCorrect: actualLocation === expectedLocation,
      confidence: result.confidence,
      probabilities: result.probabilities,
      status: response.status,
      choice: result.choice,
      correct: response.status === "ok" && result.choice === fixture.expected,
      latencyMs: result.latencyMs,
      usage: result.usage,
      estimatedUsd: estimateRoutingUsd(result.usage),
    });
  }
  process.stdout.write(
    JSON.stringify(
      {
        model: SHADOW_MODEL,
        promptVersion: SHADOW_PROMPT_VERSION,
        requests: results.length,
        offset,
        placementAccuracy:
          results.filter((r) => r.placementCorrect).length / results.length,
        accuracy: results.filter((r) => r.correct).length / results.length,
        failures: results.filter((r) => r.status !== "ok").length,
        metrics: summarizeRouting(
          results.map((r) => ({ status: r.status, result: r }))
        ),
        results,
      },
      null,
      2
    ) + "\n"
  );
}
