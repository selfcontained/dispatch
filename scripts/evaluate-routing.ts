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
const fixtures = [
  {
    name: "explain-prior-choice",
    expected: "initiating_discussion",
    incoming: "Why did you choose that approach?",
    anchor: "Please improve the parser.",
    nearby: [
      {
        role: "assistant",
        text: "I used a lookup table to keep parsing predictable.",
      },
    ],
  },
  {
    name: "new-independent-task",
    expected: "home_root",
    incoming: "New unrelated task: implement the account export endpoint.",
    anchor: "Explain this CSS rule.",
    nearby: [{ role: "assistant", text: "The margin separates these labels." }],
  },
  {
    name: "clarify-answer",
    expected: "initiating_discussion",
    incoming: "Can you give a small example of what you just explained?",
    anchor: "How does caching work?",
    nearby: [
      {
        role: "assistant",
        text: "Cached results are reused until invalidated.",
      },
    ],
  },
  {
    name: "explicit-root",
    expected: "home_root",
    incoming: "Please answer at the home root: summarize all completed work.",
    anchor: "A minor implementation discussion.",
    nearby: [],
  },
  {
    name: "followup-correction",
    expected: "initiating_discussion",
    incoming: "In your example above, why is the result zero?",
    anchor: "Explain integer rounding.",
    nearby: [
      {
        role: "assistant",
        text: "The example divides one by two using integers and gets zero.",
      },
    ],
  },
  {
    name: "fresh-work",
    expected: "home_root",
    incoming: "Start a separate task to add dark mode to the dashboard.",
    anchor: "Which rounding rule applies?",
    nearby: [],
  },
  {
    name: "uncertain",
    expected: "keep_existing_default",
    incoming: "okay",
    anchor: "",
    nearby: [],
  },
  {
    name: "explicit-discussion",
    expected: "initiating_discussion",
    incoming: "Keep this answer in this discussion: explain the second option.",
    anchor: "Which database index is best?",
    nearby: [
      {
        role: "assistant",
        text: "Option one is a single-column index, option two is composite.",
      },
    ],
  },
];
const args = process.argv.slice(2);
const position = args.indexOf("--limit");
const limit = position >= 0 ? Number(args[position + 1]) : fixtures.length;
if (
  !args.includes("--live") ||
  !process.env.DISPATCH_DECISIONS_API_KEY?.trim() ||
  !Number.isInteger(limit) ||
  limit < 1 ||
  limit > Math.min(12, fixtures.length)
) {
  process.stdout.write(
    "No requests made. Set DISPATCH_DECISIONS_API_KEY and run bun scripts/evaluate-routing.ts --live --limit N (1–8). Parent owns the authorized live batch.\n"
  );
  process.exitCode = 1;
} else {
  const results = [];
  for (const fixture of fixtures.slice(0, limit)) {
    const response = await requestRoutingDecision(
      process.env.DISPATCH_DECISIONS_API_KEY.trim(),
      JSON.stringify({
        incoming: [fixture.incoming],
        anchor: fixture.anchor,
        nearby: fixture.nearby,
        hasInitiatingDiscussion: true,
      })
    );
    const result = response.result as {
      choice?: string;
      latencyMs: number;
      usage?: unknown;
    };
    results.push({
      name: fixture.name,
      expected: fixture.expected,
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
