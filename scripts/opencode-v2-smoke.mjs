// Run from the repository root with Bun. Uses no credentials or paid models.
// bun scripts/opencode-v2-smoke.mjs /absolute/path/to/opencode [ask|deny] [V1-binary]
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { Transform } from "node:stream";
const from = (p) =>
  import(
    pathToFileURL(join(process.cwd(), "apps/server/src/agents/acp", p)).href
  );
const { AcpDriver } = await from("driver.ts");
const { openCodeInstructionsEnv } = await from("opencode-instructions.ts");
const { applyLaunchEffort } = await from("launch-effort.ts");
const { engineSpecFor } = await from("engine-spec.ts");
assert(process.argv[2], "pass the absolute path to an installed V2 binary");
assert(
  [undefined, "ask", "deny"].includes(process.argv[3]),
  "case must be ask or deny"
);
const root = await mkdtemp(join(tmpdir(), "dispatch-opencode-v2-wire-"));
const cwd = join(root, "workspace");
await mkdir(cwd);
const mcpCalls = [];
const providerCalls = [];
const requested = new Set();
let cancelObserved;
const cancelling = new Promise((resolve) => {
  cancelObserved = resolve;
});
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const isMcp = new URL(req.url).pathname === "/mcp";
    if (req.method !== "POST") {
      if (isMcp) mcpCalls.push(req.method);
      return new Response(null, { status: 405 });
    }
    const b = await req.json();
    if (isMcp) {
      mcpCalls.push(
        b.method +
          " " +
          (req.headers.get("Authorization") === "Bearer probe"
            ? "bearer"
            : "no bearer")
      );
      if (b.id == null) return new Response(null, { status: 202 });
      const r =
        b.method === "initialize"
          ? {
              protocolVersion: b.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "probe", version: "1" },
            }
          : b.method === "tools/call"
            ? { content: [{ type: "text", text: "fixture tool result" }] }
            : {
                tools: [
                  {
                    name: "probe_tool",
                    description: "Get a fixture result",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              };
      return Response.json({ jsonrpc: "2.0", id: b.id, result: r });
    }
    const tools = (b.tools ?? []).map((t) => t.function?.name).filter(Boolean);
    const prompt = JSON.stringify(b.messages);
    providerCalls.push({
      title: tools.length === 0,
      tools: tools.slice(0, 35),
      hasInstructions: prompt.includes("DISPATCH_SMOKE_INSTRUCTIONS"),
      model: b.model,
      effort: b.reasoning_effort,
      hasShellResult: prompt.includes("dispatch-permission-fixture"),
    });
    const shell = tools.find((n) => n === "shell" || n === "bash");
    const mcp =
      tools.find((n) => n.includes("probe_tool")) ??
      tools.find((n) => n === "execute");
    const active = prompt.includes("probe shell action")
      ? "shell"
      : prompt.includes("probe mcp action")
        ? "mcp"
        : null;
    const choice = active === "shell" ? shell : active === "mcp" ? mcp : null;
    let delta = { role: "assistant", content: "fixture reply" };
    let finish = "stop";
    if (choice && !requested.has(active)) {
      requested.add(active);
      finish = "tool_calls";
      const args =
        choice === "execute"
          ? { code: "return await tools.dispatch.probe_tool({})" }
          : active === "shell"
            ? {
                command: "echo dispatch-permission-fixture",
                description: "Print fixture text",
                workdir: cwd,
                timeout: 3000,
              }
            : {};
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_" + active,
            type: "function",
            function: { name: choice, arguments: JSON.stringify(args) },
          },
        ],
      };
    }
    const chunk = (delta, finish_reason = null) => ({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: b.model,
      choices: [{ index: 0, delta, finish_reason }],
      ...(finish_reason
        ? {
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
            },
          }
        : {}),
    });
    if (JSON.stringify(b.messages?.at(-1)).includes("probe cancellation")) {
      cancelObserved();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                "data: " +
                  JSON.stringify(
                    chunk({ role: "assistant", content: "waiting" })
                  ) +
                  "\n\n"
              )
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
    }
    return new Response(
      [chunk(delta), chunk({}, finish)]
        .map((x) => "data: " + JSON.stringify(x) + "\n\n")
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } }
    );
  },
});
const env = {
  PATH: process.env.PATH,
  HOME: root,
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  FIXTURE_API_KEY: "probe",
};
for (const key of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
])
  env[key] = join(root, key);
const version = execFileSync(process.argv[2], ["--version"], {
  env,
  encoding: "utf8",
}).trim();
assert(/(?:^|\s)v?2\./.test(version), `expected OpenCode V2, got ${version}`);
const config = {
  model: "fixture/coder",
  providers: {
    fixture: {
      package: "@opencode/ai/providers/openai-compatible",
      env: ["FIXTURE_API_KEY"],
      settings: { baseURL: server.url.href + "v1" },
      models: {
        coder: {
          name: "Coder",
          capabilities: { tool_call: true },
          variants: [{ id: "high", body: { reasoning_effort: "high" } }],
        },
      },
    },
  },
};
const engine = engineSpecFor(
  "opencode",
  { claudeBin: "", codexBin: null, opencodeBin: process.argv[2] },
  false
);
config.permissions = [
  {
    action: "shell",
    resource: "*",
    effect: process.argv[3] === "deny" ? "deny" : "ask",
  },
];
const fixtureEnv = await openCodeInstructionsEnv(
  root,
  "DISPATCH_SMOKE_INSTRUCTIONS",
  { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
);
const d = new AcpDriver({
  onPermissions(agentId, requests) {
    for (const r of requests) {
      permissions.push({
        title: r.title,
        options: r.options.map((x) => x.kind),
      });
      queueMicrotask(() =>
        d.answerPermission(
          agentId,
          r.id,
          r.options.find((x) => x.kind === "reject_once")?.optionId ?? null
        )
      );
    }
  },
  logger: {
    info() {},
    warn(...x) {
      console.error("driver warning", x.at(-1));
    },
    error() {},
  },
  spawn(bin, args, opt) {
    const child = spawn(bin, args, { ...opt, stdio: ["pipe", "pipe", "pipe"] });
    let pending = "";
    const tap = new Transform({
      transform(buf, _enc, cb) {
        pending += buf.toString();
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) {
          try {
            const j = JSON.parse(line);
            if (j.method && j.method !== "session/update")
              console.error(
                "ACP incoming",
                j.method,
                JSON.stringify(j.params).slice(0, 1200)
              );
          } catch {}
        }
        cb(null, buf);
      },
    });
    child.stdout = child.stdout.pipe(tap);
    child.stderr.on("data", (x) =>
      console.error("stderr", x.toString().slice(0, 1600))
    );
    return child;
  },
});
const id = "agt_probe";
const permissions = [];
const toolEvents = [];
const settledTurns = [];
let streamedText = false;
d.onEvent((e) => {
  if (e.type === "turn" && e.state === "settled") settledTurns.push(e);
  if (e.type === "update" && e.update.sessionUpdate === "agent_message_chunk")
    streamedText = true;
  if (e.type === "update" && e.update.sessionUpdate.startsWith("tool_call"))
    toolEvents.push({ title: e.update.title, status: e.update.status });
});
const waiter = setTimeout(() => {
  console.error(
    "timeout",
    JSON.stringify({ mcpCalls, providerCalls, permissions, toolEvents })
  );
  void d.cancel(id);
}, 30000);
try {
  let v1SessionId;
  if (process.argv[4]) {
    const v1 = await d.start({
      agentId: id,
      cwd,
      engine: engineSpecFor(
        "opencode",
        { claudeBin: "", codexBin: null, opencodeBin: process.argv[4] },
        true
      ),
      env: {
        ...env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model: "fixture/coder",
          provider: {
            fixture: {
              npm: "@ai-sdk/openai-compatible",
              name: "Fixture",
              options: { baseURL: server.url.href + "v1", apiKey: "probe" },
              models: {
                coder: { name: "Coder", limit: { context: 8192, output: 512 } },
              },
            },
          },
        }),
      },
      mcp: { url: server.url.href + "mcp", token: "probe" },
    });
    await d.prompt(id, "probe V1 fixture persistence");
    v1SessionId = v1.sessionId;
    await d.stop(id);
  }
  const start = await d.start({
    agentId: id,
    cwd,
    engine,
    model: "fixture/coder",
    effort: "high",
    sessionId: v1SessionId,
    env: fixtureEnv,
    mcp: { url: server.url.href + "mcp", token: "probe" },
  });
  await applyLaunchEffort(d, id, "opencode", "high");
  await d.prompt(id, "probe mcp action");
  await d.prompt(id, "probe shell action");
  assert(
    mcpCalls.includes("tools/call bearer"),
    "Code Mode must invoke the authenticated MCP tool"
  );
  assert(
    providerCalls.some((c) => c.tools.includes("execute")),
    "default Code Mode must remain enabled"
  );
  assert.equal(
    permissions.length,
    0,
    "full-access approvals should be handled by the driver"
  );
  assert.equal(
    providerCalls.some((c) => c.hasShellResult),
    process.argv[3] !== "deny",
    "native deny must block; native ask must complete in full access"
  );
  assert(
    providerCalls.some((c) => c.hasInstructions),
    "native instructions reach the provider"
  );
  assert(
    providerCalls.filter((c) => !c.title).every((c) => c.model === "coder"),
    "selected model reaches provider"
  );
  if (v1SessionId)
    assert.equal(
      start.sessionId,
      v1SessionId,
      "V1 session identity must survive V2 resume"
    );
  assert(
    providerCalls.some((c) => c.effort === "high"),
    "selected effort reaches provider"
  );
  assert(streamedText, "streamed text must reach ACP driver");
  assert(
    settledTurns.some((t) => t.usage),
    "provider usage must reach ACP driver"
  );
  const originalSessionId = start.sessionId;
  await d.stop(id);
  const resumed = await d.start({
    agentId: id,
    cwd,
    engine,
    sessionId: originalSessionId,
    env: fixtureEnv,
    mcp: { url: server.url.href + "mcp", token: "probe" },
  });
  assert.equal(resumed.sessionId, originalSessionId);
  assert(resumed.resumed, "must resume the existing session");
  await applyLaunchEffort(d, id, "opencode", "high");
  await d.prompt(id, "probe resumed reply");
  const cancelledTurn = d.prompt(id, "probe cancellation");
  await cancelling;
  await d.cancel(id);
  await cancelledTurn;
  assert.equal(settledTurns.at(-1)?.stopReason, "cancelled");
  console.log(
    JSON.stringify({
      binary: process.argv[2],
      version,
      v1Resumed: Boolean(v1SessionId),
      cancelled: true,
      streamedText,
      settledTurns,
      case: process.argv[3] ?? "ask",
      resumed: resumed.resumed,
      mcpCalls,
      providerCalls,
      permissions,
      toolEvents,
    })
  );
} finally {
  clearTimeout(waiter);
  await d.stop(id);
  server.stop(true);
  await rm(root, { recursive: true, force: true });
}
