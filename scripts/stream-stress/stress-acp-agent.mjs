#!/usr/bin/env node
// Stress ACP agent: stands in for every engine on a stream-stress stack
// (DISPATCH_ACP_ADAPTER_COMMAND). A prompt carrying `stress:steps=N` runs a
// long turn of N tool calls whose kinds and payload sizes follow what real
// Claude/Codex turns in the dogfood stream carried (September 2026 sample of
// 1,665 steps): mostly shell commands and thoughts, some reads with output,
// a few edits whose diffs run to tens of KB. Anything else gets a short
// two-step turn. Payloads are generated from a seed, so a run is repeatable.
// `ms=M` sets the pause per step (default STRESS_STEP_MS or 250).
// It never calls a model and never touches the workspace.
import { createRequire } from "node:module";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  path.resolve(here, "../../apps/server/package.json")
);
const acp = require("@agentclientprotocol/sdk");

const STEP_MS_DEFAULT = Number(process.env.STRESS_STEP_MS ?? 250);

/** Small deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  "stream block turn feed thread review finding agent cache render query page cursor entry reply payload layout scroll event state delivery launch child parent composer drawer".split(
    " "
  );

function sentence(r, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(WORDS[Math.floor(r() * WORDS.length)]);
  return out.join(" ");
}

/** Roughly `bytes` of TypeScript-looking source. */
function source(r, bytes, tag) {
  const lines = [];
  let size = 0;
  let i = 0;
  while (size < bytes) {
    const line =
      i % 7 === 0
        ? `export function ${tag}${i}(input: ${WORDS[i % WORDS.length]}State): number {`
        : i % 7 === 6
          ? "}"
          : `  const ${WORDS[Math.floor(r() * WORDS.length)]}${i} = input.${sentence(r, 1)}?.length ?? ${i}; // ${sentence(r, 4)}`;
    lines.push(line);
    size += line.length + 1;
    i += 1;
  }
  return lines.join("\n");
}

function terminal(r, bytes) {
  const lines = [];
  let size = 0;
  let i = 0;
  while (size < bytes) {
    const line =
      r() < 0.15
        ? ` ✓ src/${WORDS[i % WORDS.length]}/${sentence(r, 1)}.test.ts (${Math.floor(r() * 40)} tests) ${Math.floor(r() * 900)}ms`
        : `  ${sentence(r, 8)}`;
    lines.push(line);
    size += line.length + 1;
    i += 1;
  }
  return lines.join("\n");
}

/** Size in bytes drawn from a band, skewed toward its low end. */
function sized(r, lo, hi) {
  return Math.floor(lo + (hi - lo) * r() * r());
}

/** One tool call's shape, in proportion to the dogfood sample. */
function step(r, i, cwd) {
  const pick = r();
  const file = path.join(cwd, `src/${WORDS[i % WORDS.length]}/${sentence(r, 1)}.ts`);
  if (pick < 0.45) {
    const withOutput = r() < 0.25;
    return {
      title: `pnpm vitest run ${sentence(r, 1)}`,
      kind: "execute",
      rawInput: { command: `pnpm vitest run src/${sentence(r, 2).replace(" ", "/")}` },
      content: withOutput
        ? [{ type: "content", content: { type: "text", text: terminal(r, sized(r, 1_500, 16_000)) } }]
        : [{ type: "content", content: { type: "text", text: terminal(r, 300) } }],
    };
  }
  if (pick < 0.65) return { thought: sentence(r, 30 + Math.floor(r() * 90)) };
  if (pick < 0.77) {
    const withOutput = r() < 0.2;
    return {
      title: `Read ${path.basename(file)}`,
      kind: "read",
      locations: [{ path: file }],
      content: withOutput
        ? [{ type: "content", content: { type: "text", text: source(r, sized(r, 5_000, 35_000), "read") } }]
        : [],
    };
  }
  if (pick < 0.84) {
    const oldText = source(r, sized(r, 2_000, 60_000), "old");
    return {
      title: `Edit ${path.basename(file)}`,
      kind: "edit",
      locations: [{ path: file }],
      content: [{ type: "diff", path: file, oldText, newText: `${oldText}\n${source(r, 400, "added")}` }],
    };
  }
  if (pick < 0.92) {
    return {
      title: `grep ${sentence(r, 1)}`,
      kind: "search",
      rawInput: { pattern: sentence(r, 1), path: "apps" },
      content: [{ type: "content", content: { type: "text", text: terminal(r, 400) } }],
    };
  }
  return {
    title: `fetch ${sentence(r, 2)}`,
    kind: "other",
    rawInput: { url: "https://example.test/" + sentence(r, 1) },
    content: [{ type: "content", content: { type: "text", text: terminal(r, sized(r, 400, 4_000)) } }],
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let conn;
const cwdBySession = new Map();
const cancelled = new Set();
let turnSeed = 1;

const agent = {
  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "stress-agent", version: "0.0.0" },
      agentCapabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: { close: {}, resume: {} },
      },
      authMethods: [],
    };
  },
  async authenticate() {
    return {};
  },
  async newSession(params) {
    const sessionId = `stress_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    cwdBySession.set(sessionId, params.cwd);
    return { sessionId, configOptions: [] };
  },
  async resumeSession(params) {
    cwdBySession.set(params.sessionId, params.cwd);
    return { configOptions: [] };
  },
  async setSessionMode() {
    return {};
  },
  async setSessionConfigOption() {
    return { configOptions: [] };
  },
  async prompt(params) {
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    const sessionId = params.sessionId;
    const cwd = cwdBySession.get(sessionId) ?? process.cwd();
    const emit = (update) => conn.sessionUpdate({ sessionId, update });
    cancelled.delete(sessionId);
    const directive = /stress:steps=(\d+)/.exec(text);
    const steps = directive ? Number(directive[1]) : 2;
    const seed = Number(/seed=(\d+)/.exec(text)?.[1] ?? turnSeed++);
    const STEP_MS = Number(/ms=(\d+)/.exec(text)?.[1] ?? STEP_MS_DEFAULT);
    const r = rng(seed);
    await emit({
      sessionUpdate: "plan",
      entries: [
        { content: "Read the code", status: "completed", priority: "high" },
        { content: "Make the change", status: "in_progress", priority: "medium" },
        { content: "Run the checks", status: "pending", priority: "low" },
      ],
    });
    for (let i = 0; i < steps; i += 1) {
      if (cancelled.has(sessionId)) return { stopReason: "cancelled" };
      const s = step(r, i, cwd);
      if (s.thought) {
        await emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: s.thought } });
        await sleep(STEP_MS / 2);
        continue;
      }
      const toolCallId = `t${seed}_${i}`;
      await emit({
        sessionUpdate: "tool_call",
        toolCallId,
        title: s.title,
        kind: s.kind,
        status: "in_progress",
        rawInput: s.rawInput,
        locations: s.locations ?? [],
        content: [],
      });
      await sleep(STEP_MS / 2);
      await emit({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: s.content });
      await sleep(STEP_MS / 2);
    }
    await emit({ sessionUpdate: "usage_update", used: 40_000 + steps * 900, size: 200_000, cost: { amount: 0.02 * steps, currency: "USD" } });
    const answer = [
      `Done with ${steps} steps. ${sentence(r, 40)}.`,
      "",
      "```ts",
      source(r, 600, "answer"),
      "```",
      "",
      `- ${sentence(r, 12)}`,
      `- ${sentence(r, 12)}`,
    ].join("\n");
    for (let at = 0; at < answer.length; at += 400) {
      await emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer.slice(at, at + 400) } });
      await sleep(40);
    }
    return {
      stopReason: "end_turn",
      usage: { totalTokens: 1000, inputTokens: 900, outputTokens: 100, thoughtTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
    };
  },
  async cancel(params) {
    cancelled.add(params.sessionId);
  },
  async closeSession() {
    return {};
  },
};

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
conn = new acp.AgentSideConnection(() => agent, stream);
process.stdin.on("end", () => process.exit(0));
