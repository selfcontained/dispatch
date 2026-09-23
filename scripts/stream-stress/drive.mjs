#!/usr/bin/env node
// Stream-stress workload for a live dev stack (repo_dev_up live, with
// DISPATCH_AGENT_HOST_COMMAND=scripts/stream-stress/stress-host.sh so every
// agent runs the stress engine). Builds one root stream shaped like the
// dogfood review-flow session (root agent, child builders, reviewer children,
// reviews with findings, finding discussions, long turns), scaled up, then
// optionally keeps it busy with live traffic.
//
//   node scripts/stream-stress/drive.mjs setup  --api http://127.0.0.1:PORT [--scale 1]
//   node scripts/stream-stress/drive.mjs live   --api ... --root agt_x [--seconds 120]
//
// `setup` prints the ids as JSON (root, children, reviewers, findings) for
// measure.mjs. Nothing here touches a stack other than the one named.
import { execSync } from "node:child_process";

const args = Object.fromEntries(
  process.argv
    .slice(3)
    .reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), [])
);
const mode = process.argv[2];
const API = args.api ?? "http://127.0.0.1:60466";
const SCALE = Number(args.scale ?? 1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let seed = 7;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (lo, hi) => Math.floor(lo + rand() * (hi - lo + 1));

async function api(path, init = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** An agent's MCP tool, called the way the agent itself would. */
async function tool(agentId, name, argsIn) {
  const res = await fetch(`${API}/api/mcp/${agentId}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: argsIn } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const payload = JSON.parse(line ? line.slice(6) : text);
  if (payload.error || payload.result?.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
  const body = payload.result?.content?.[0]?.text;
  try {
    return JSON.parse(body ?? "{}");
  } catch {
    return {};
  }
}

async function createAgent(name, parentAgentId) {
  const { agent } = await api("/agents", {
    method: "POST",
    body: JSON.stringify({ name, type: "claude", cwd: "/tmp", useWorktree: false, parentAgentId }),
  });
  return agent.id;
}

async function waitIdle(agentId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  await sleep(300);
  while (Date.now() < deadline) {
    const { agent } = await api(`/agents/${agentId}`);
    if (agent.status !== "creating" && agent.activity !== "working") return;
    await sleep(400);
  }
  throw new Error(`${agentId} still working after ${timeoutMs}ms`);
}

const MARKDOWN = [
  "Pushed the change. The feed now keeps its place when older pages load.",
  "Looked at the cursor code again:\n\n```ts\nconst next = page.nextCursor ?? undefined;\nif (!next) return;\n```\n\nThat part is fine.",
  "- launch card holds the child thread\n- review lands on the card\n- findings open their own threads",
  "Checks: `pnpm run check` passed, 1,652 web tests passed, e2e 155/3 skipped.",
  "I think the drawer should keep the finding open after a fix is marked. Thoughts?",
];

/** A user prompt that runs one stress turn on `agentId`, answered in the root stream. */
async function userTurn(root, agentId, steps, ms) {
  await api(`/streams/${root}/blocks`, {
    method: "POST",
    body: JSON.stringify({ to: agentId, text: `stress:steps=${steps} ms=${ms} seed=${between(1, 1e6)} ${pick(MARKDOWN)}` }),
  });
}

/**
 * The stack must run the stress engine before anything launches: an agent
 * on a stack without it would run a real engine, with real cost. The API
 * process has to carry the stress host command in its environment, and the
 * first agent's first turn has to answer the way only the stress engine
 * does; otherwise that agent is deleted and nothing else is launched.
 */
function assertStressHost() {
  const port = new URL(API).port;
  const pid = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN || true`).toString().trim().split("\n")[0];
  const env = pid ? execSync(`ps eww -p ${pid} -o command=`).toString() : "";
  if (!/DISPATCH_AGENT_HOST_COMMAND=\S*stress-host\.sh/.test(env) || !/DISPATCH_AGENT_RUNTIME=acp/.test(env)) {
    throw new Error(
      `the API on :${port} does not run the stress host (DISPATCH_AGENT_HOST_COMMAND=…/stress-host.sh, live runtime); refusing to launch agents`
    );
  }
}

async function assertStressEngine(agentId) {
  await api(`/streams/${agentId}/blocks`, { method: "POST", body: JSON.stringify({ to: agentId, text: "stress:steps=1 ms=1 canary" }) });
  await waitIdle(agentId);
  const { entries } = await api(`/streams/${agentId}/blocks?limit=10`);
  const answer = entries.map((e) => e.block.turn?.result?.text ?? "").find(Boolean) ?? "";
  if (!answer.startsWith("Done with 1 steps.")) {
    await api(`/agents/${agentId}?cleanupWorktree=force`, { method: "DELETE" }).catch(() => {});
    throw new Error(`the first agent did not answer as the stress engine (got ${JSON.stringify(answer.slice(0, 80))}); deleted it and stopped`);
  }
}

async function setup() {
  const t0 = Date.now();
  assertStressHost();
  const root = await createAgent("stress root: review flow");
  await waitIdle(root);
  await assertStressEngine(root);
  const builders = [];
  const reviewers = [];
  for (let i = 1; i <= 3; i += 1) builders.push(await createAgent(`stress builder ${i}`, root));
  for (let i = 1; i <= 2; i += 1) reviewers.push(await createAgent(`stress reviewer ${i}`, root));
  for (const id of [root, ...builders, ...reviewers]) await waitIdle(id);

  // Root history: moderate turns and posts, the bulk of the pages.
  const rootTurns = Math.round(60 * SCALE);
  for (let i = 0; i < rootTurns; i += 1) {
    await userTurn(root, root, between(3, 40), 4);
    if (i % 3 === 0) await tool(pick(builders), "post", { text: pick(MARKDOWN) });
    if (i % 4 === 0) await tool(root, "post", { text: pick(MARKDOWN) });
    await waitIdle(root);
  }
  // Two giant turns, the dogfood session's worst row.
  for (let i = 0; i < 2; i += 1) {
    await userTurn(root, root, 305, 2);
    await waitIdle(root, 300_000);
  }
  // Child work: each builder is prompted by the root; its turns land in its
  // launch thread.
  for (const builder of builders) {
    for (let i = 0; i < Math.round(15 * SCALE); i += 1) {
      await tool(root, "post", { to: builder, text: `stress:steps=${between(3, 25)} ms=4 ${pick(MARKDOWN)}` });
      await waitIdle(builder);
    }
  }
  // Reviews with findings, and a discussion under each finding.
  const findings = [];
  for (const reviewer of reviewers) {
    const review = await tool(reviewer, "post", {
      to: root,
      text: "Review of the stream changes.",
      review: {
        summary: "Findings on the review flow.",
        findings: Array.from({ length: 12 }, (_, n) => ({
          severity: pick(["major", "minor", "nit"]),
          title: `Finding ${n + 1}: ${pick(MARKDOWN).slice(0, 50)}`,
          body: pick(MARKDOWN),
          path: "apps/web/src/components/app/chat/chat-feed.tsx",
          line: between(1, 400),
        })),
      },
    });
    findings.push(...(review.findings ?? []).map((f) => f.id));
    await waitIdle(root);
  }
  // Every finding gets a short back-and-forth; one gets a very long one.
  for (const [n, finding] of findings.entries()) {
    const replies = n === 0 ? Math.round(150 * SCALE) : 6;
    let replyTo = finding;
    for (let i = 0; i < replies; i += 1) {
      const author = i % 2 === 0 ? root : reviewers[n < 12 ? 0 : 1];
      const posted = await tool(author, "post", { replyTo, text: pick(MARKDOWN) });
      replyTo = posted.id ?? replyTo;
    }
  }
  for (const id of [root, ...builders, ...reviewers]) await waitIdle(id, 300_000);
  const feed = await api(`/streams/${root}/blocks?limit=100`);
  console.log(
    JSON.stringify({ root, builders, reviewers, findings, seconds: Math.round((Date.now() - t0) / 1000), firstPageBytes: JSON.stringify(feed).length, hasMore: feed.hasMore })
  );
}

/**
 * Live traffic: the root on a long turn at real pace, builders on turns in
 * their threads, agents posting, the reviewer and root talking under a
 * finding. Roughly what several agents conversing at once put on the wire.
 */
async function live() {
  assertStressHost();
  const root = args.root;
  const { agents } = await api("/agents");
  const kids = agents.filter((a) => a.parentAgentId === root);
  const builders = kids.filter((a) => a.name.includes("builder")).map((a) => a.id);
  const reviewers = kids.filter((a) => a.name.includes("reviewer")).map((a) => a.id);
  const finding = args.finding;
  const until = Date.now() + Number(args.seconds ?? 120) * 1000;
  await userTurn(root, root, 400, 250);
  let n = 0;
  while (Date.now() < until) {
    n += 1;
    const roll = rand();
    try {
      if (roll < 0.25) await tool(root, "post", { to: pick(builders), text: `stress:steps=${between(10, 40)} ms=250 ${pick(MARKDOWN)}` });
      else if (roll < 0.55) await tool(pick([...builders, root]), "post", { text: pick(MARKDOWN) });
      else if (roll < 0.8 && finding) await tool(pick(reviewers), "post", { replyTo: finding, text: pick(MARKDOWN) });
      else await tool(pick(reviewers), "react", { blockId: finding ?? root, emoji: pick(["👍", "👀", "✅"]) }).catch(() => {});
    } catch (error) {
      console.error(String(error).slice(0, 200));
    }
    await sleep(1_500);
  }
  console.log(JSON.stringify({ actions: n }));
}

if (mode === "setup") await setup();
else if (mode === "live") await live();
else {
  console.error("usage: drive.mjs setup|live --api URL [--scale N] [--root ID --finding ID --seconds S]");
  process.exit(2);
}
