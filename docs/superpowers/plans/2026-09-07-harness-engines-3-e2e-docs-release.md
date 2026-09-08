# Dispatch Harness engines, plan 3 of 3: e2e, docs, release

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the four-engine harness end to end with a fake ACP agent that speaks each engine's dialect, document the engines for operators, scrub every dsh trace from docs and release notes, cut the first `-harness` prerelease, and run the live smoke on an isolated stack.

**Architecture:** One fixture, `e2e/fixtures/fake-acp-agent.mjs`, stands in for all four engine binaries and infers which engine it is from the arguments the driver passes; the e2e spec runs its scenario once per engine. Docs describe the engines table from the spec. Nothing here touches the production install at `/home/nii/.dispatch/server`; the live smoke runs on `repo_dev_up`. Plans 1 and 2 must be complete.

**Tech Stack:** Playwright, Node ESM, `@agentclientprotocol/sdk`, bash, Markdown.

## Global Constraints

- The fixture never calls a model and never touches the workspace; every turn is scripted from the prompt text.
- The e2e suite runs under `scripts/e2e-isolated.sh` with `E2E_AGENT_RUNTIME=tmux` for the harness spec (the agent's setup script runs in tmux before the ACP child starts). Never `waitUntil: "networkidle"` on the app; wait for concrete test ids.
- Playwright runs the harness spec with `page.emulateMedia({ reducedMotion: "reduce" })`.
- Docs: American spelling, no em-dashes, backtick every literal, tables for the engine comparison, no time estimates. Engine names as in `HARNESS_ENGINES`.
- Version pins from the spec: `@agentclientprotocol/claude-agent-acp@0.70.0`, `@agentclientprotocol/codex-acp@1.7.0`, `@google/gemini-cli@0.57.0`, `opencode-ai@1.18.29`.
- Prerelease tags continue as `0.38.13-harness.N`; six manifests move together (root, `apps/server`, `apps/web`, `packages/shared`, `apps/browser-extension`, `apps/browser-extension/public/manifest.json`).
- Production (`127.0.0.1:6767`) is not touched by any task here.

---

### Task 1: The fake ACP agent speaks four dialects

**Files:**

- Move: `e2e/fixtures/fake-dsh.mjs` → `e2e/fixtures/fake-acp-agent.mjs`
- Modify: `scripts/e2e-isolated.sh:52-56,96`
- Modify: `playwright.config.ts:32-33,64-71`

**Interfaces:**

- Produces: a stdio ACP agent that, given the driver's arguments, behaves as `claude` (`--dangerously-skip-permissions`), `gemini` (`--experimental-acp`), `opencode` (`acp`), or `codex` (no arguments); env `FAKE_ACP_ENGINE` overrides the inference.

- [ ] **Step 1: Move and rewrite the fixture**

```bash
cd /home/nii/.dispatch/server-dsh-harness && git mv e2e/fixtures/fake-dsh.mjs e2e/fixtures/fake-acp-agent.mjs
```

Replace its contents with:

```js
#!/usr/bin/env node
// Fake ACP agent for E2E: stands in for every harness engine binary. It
// infers which engine it is from the arguments the driver passes (or from
// FAKE_ACP_ENGINE), and emits what that engine emits: plans for Claude and
// Codex, usage with cost for Claude and OpenCode, a model option for the
// three that publish one, nested tool calls for Claude, a permission ask
// for OpenCode, and honors set_mode for Gemini. It never calls a model and
// never touches the workspace.
import { createRequire } from "node:module";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  path.resolve(here, "../../apps/server/package.json")
);
const acp = require("@agentclientprotocol/sdk");

function inferEngine(argv) {
  if (process.env.FAKE_ACP_ENGINE) return process.env.FAKE_ACP_ENGINE;
  if (argv.includes("--dangerously-skip-permissions")) return "claude";
  if (argv.includes("--experimental-acp")) return "gemini";
  if (argv.includes("acp")) return "opencode";
  return "codex";
}
const ENGINE = inferEngine(process.argv.slice(2));
const PROFILE = {
  claude: {
    plan: "plan",
    usage: true,
    cost: true,
    model: true,
    nested: true,
    ask: false,
  },
  codex: {
    plan: "plan_update",
    usage: true,
    cost: false,
    model: true,
    nested: false,
    ask: false,
  },
  gemini: {
    plan: null,
    usage: false,
    cost: false,
    model: false,
    nested: false,
    ask: false,
  },
  opencode: {
    plan: null,
    usage: true,
    cost: true,
    model: true,
    nested: false,
    ask: true,
  },
}[ENGINE];
if (!PROFILE) {
  process.stderr.write(`fake-acp-agent: unknown engine ${ENGINE}\n`);
  process.exit(2);
}
process.stderr.write(
  `fake-acp-agent engine=${ENGINE} argv=${JSON.stringify(process.argv.slice(2))}\n`
);

let conn;
const cwdBySession = new Map();
const modeBySession = new Map();
const modelBySession = new Map();
const SLEEP = /sleep:(\d+)/;
const RUN = /run:(\d+)/;
const sleeping = new Map();

const MODEL_OPTION = (current) => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: current,
  options: [
    { value: "default-model", name: "Default model" },
    { value: "other-model", name: "Other model" },
  ],
});
const configOptions = (sessionId) =>
  PROFILE.model
    ? [MODEL_OPTION(modelBySession.get(sessionId) ?? "default-model")]
    : [];

const agent = {
  async initialize(params) {
    process.stderr.write(
      `fake-acp-agent initialize meta=${JSON.stringify(params.clientCapabilities?._meta ?? null)}\n`
    );
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: `fake-${ENGINE}`, version: "0.0.0" },
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
    const sessionId = `fake_${ENGINE}_${Date.now()}`;
    cwdBySession.set(sessionId, params.cwd);
    process.stderr.write(
      `fake-acp-agent newSession cwd=${params.cwd} meta=${JSON.stringify(params._meta ?? null)} mcp=${JSON.stringify((params.mcpServers ?? []).map((s) => s.name))}\n`
    );
    setTimeout(() => {
      void conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            {
              name: "review",
              description: `Review the branch (${ENGINE})`,
              input: null,
            },
            {
              name: "compact",
              description: "Compact the context",
              input: { hint: "what to keep" },
            },
          ],
        },
      });
    }, 0);
    return { sessionId, configOptions: configOptions(sessionId) };
  },
  async resumeSession(params) {
    cwdBySession.set(params.sessionId, params.cwd);
    return { configOptions: configOptions(params.sessionId) };
  },
  async setSessionMode(params) {
    modeBySession.set(params.sessionId, params.modeId);
    process.stderr.write(`fake-acp-agent set_mode ${params.modeId}\n`);
    return {};
  },
  async setSessionConfigOption(params) {
    if (params.configId === "model")
      modelBySession.set(params.sessionId, params.value);
    return { configOptions: configOptions(params.sessionId) };
  },
  async prompt(params) {
    const text = params.prompt
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const cwd = cwdBySession.get(params.sessionId) ?? process.cwd();
    const emit = (update) =>
      conn.sessionUpdate({ sessionId: params.sessionId, update });
    const sleep = SLEEP.exec(text);
    if (sleep) {
      const cancelled = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), Number(sleep[1]));
        sleeping.set(params.sessionId, () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      sleeping.delete(params.sessionId);
      if (cancelled) return { stopReason: "cancelled" };
    }
    const run = RUN.exec(text);
    if (run) {
      await emit({
        sessionUpdate: "tool_call",
        toolCallId: "run1",
        title: "bash",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: `sleep ${Number(run[1]) / 1000}` },
        content: [],
      });
      await new Promise((resolve) => setTimeout(resolve, Number(run[1])));
      await emit({
        sessionUpdate: "tool_call_update",
        toolCallId: "run1",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "slept well" } },
        ],
      });
    }
    if (PROFILE.ask) {
      const answer = await conn.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "c1", title: "Read README.md" },
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "always", name: "Always", kind: "allow_always" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      process.stderr.write(
        `fake-acp-agent permission=${JSON.stringify(answer.outcome)}\n`
      );
    }
    await emit({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Read README.md",
      kind: "read",
      status: "in_progress",
      locations: [{ path: path.join(cwd, "README.md") }],
      content: [],
    });
    await emit({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
    });
    if (PROFILE.nested && /subagent:/.test(text)) {
      await emit({
        sessionUpdate: "tool_call",
        toolCallId: "task1",
        title: "Task",
        kind: "other",
        status: "in_progress",
        rawInput: { description: "look around" },
        content: [],
      });
      await emit({
        sessionUpdate: "tool_call",
        toolCallId: "child1",
        title: "Read",
        kind: "read",
        status: "completed",
        locations: [{ path: path.join(cwd, "src/index.ts") }],
        content: [],
        _meta: { claudeCode: { toolName: "Read", parentToolUseId: "task1" } },
      });
      await emit({
        sessionUpdate: "tool_call_update",
        toolCallId: "task1",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "child finished" },
          },
        ],
      });
    }
    if (PROFILE.plan && /tasks:/.test(text)) {
      const entries = [
        { content: "Read the README", status: "completed", priority: "high" },
        {
          content: "Echo the prompt",
          status: "in_progress",
          priority: "medium",
        },
        { content: "Wrap up", status: "pending", priority: "low" },
      ];
      await emit(
        PROFILE.plan === "plan"
          ? { sessionUpdate: "plan", entries }
          : {
              sessionUpdate: "plan_update",
              plan: { type: "items", planId: "p1", entries },
            }
      );
    }
    if (PROFILE.usage) {
      await emit({
        sessionUpdate: "usage_update",
        used: 12_000,
        size: 200_000,
        ...(PROFILE.cost ? { cost: { amount: 0.42, currency: "USD" } } : {}),
      });
    }
    for (const piece of [
      "You said: ",
      text.replace(/^[\s\S]*?--- DISPATCH CHAT[^\n]*\n/, ""),
    ]) {
      await emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: piece },
      });
    }
    return {
      stopReason: "end_turn",
      usage: {
        totalTokens: 120,
        inputTokens: 100,
        outputTokens: 20,
        thoughtTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
    };
  },
  async cancel(params) {
    sleeping.get(params.sessionId)?.();
  },
  async closeSession() {
    return {};
  },
};

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin)
);
conn = new acp.AgentSideConnection(() => agent, stream);
process.stdin.on("end", () => process.exit(0));
```

- [ ] **Step 2: Point every engine binary at the fixture**

`scripts/e2e-isolated.sh` lines 52 to 56 become:

```bash
# Harness agents talk to an engine over ACP stdio. The suite never runs a
# real engine: the fake in e2e/fixtures speaks the protocol for all four and
# scripts one turn per prompt.
FAKE_ACP="$PWD/e2e/fixtures/fake-acp-agent.mjs"
export DISPATCH_CLAUDE_HARNESS_BIN="${DISPATCH_CLAUDE_HARNESS_BIN:-$FAKE_ACP}"
export DISPATCH_CODEX_HARNESS_BIN="${DISPATCH_CODEX_HARNESS_BIN:-$FAKE_ACP}"
export DISPATCH_GEMINI_BIN="${DISPATCH_GEMINI_BIN:-$FAKE_ACP}"
export DISPATCH_OPENCODE_BIN="${DISPATCH_OPENCODE_BIN:-$FAKE_ACP}"
```

and line 96 drops `"$DISPATCH_DSH_HOME"`. In `playwright.config.ts` the list entry becomes `"e2e/harness-agent.spec.ts",` with the comment "Also flips the chat surface flag, and enables the dispatch agent type.", and the six blanked provider keys in `webServer.env` are deleted (nothing reads them now).

- [ ] **Step 3: Smoke the fixture by hand**

```bash
cd /home/nii/.dispatch/server-dsh-harness
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}}}}' \
  | node e2e/fixtures/fake-acp-agent.mjs --experimental-acp 2>/tmp/claude-30034/fake.err | head -c 300; echo; cat /tmp/claude-30034/fake.err
```

Expected: stderr says `engine=gemini`, stdout carries the `initialize` result with `agentInfo.name` `fake-gemini`.

- [ ] **Step 4: Commit**

```bash
git add -A e2e/fixtures scripts/e2e-isolated.sh playwright.config.ts
git commit -m "test(e2e): one fake ACP agent that speaks all four engine dialects

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The harness e2e spec runs once per engine

**Files:**

- Move: `e2e/dsh-agent.spec.ts` → `e2e/harness-agent.spec.ts`
- Modify: `e2e/helpers.ts:67-80` (`model` override)

- [ ] **Step 1: Let `createAgentViaAPI` set a model**

In `e2e/helpers.ts` add `model?: string;` to the `overrides` type (comment: "The engine and model for a dispatch agent, as engine/model.") and pass it through in the request body the same way `initialPrompt` is passed.

- [ ] **Step 2: Rewrite the spec**

```bash
cd /home/nii/.dispatch/server-dsh-harness && git mv e2e/dsh-agent.spec.ts e2e/harness-agent.spec.ts
```

Keep `setChatSurface`, `makeRepo`, and the three existing tests (the `@` path picker and the queue tests are engine-independent; rename their agent names from `e2e-dsh-` to `e2e-harness-`, and add `await page.emulateMedia({ reducedMotion: "reduce" });` right after `loadApp(page)` in each). Replace the first test with a per-engine loop:

```ts
const ENGINES = [
  {
    model: "claude/default",
    plan: true,
    cost: true,
    chipFixed: false,
    nested: true,
  },
  {
    model: "codex/default",
    plan: true,
    cost: false,
    chipFixed: false,
    nested: false,
  },
  {
    model: "gemini/default",
    plan: false,
    cost: false,
    chipFixed: true,
    nested: false,
  },
  {
    model: "opencode/default",
    plan: false,
    cost: true,
    chipFixed: false,
    nested: false,
  },
] as const;

for (const engine of ENGINES) {
  test(`${engine.model}: opens on the Harness view, runs a turn, shows what the engine publishes`, async ({
    page,
    request,
  }) => {
    await setEnabledAgentTypesViaAPI(request, ["claude", "codex", "dispatch"]);
    await setChatSurface(request, true);
    const repo = makeRepo();
    const agent = await createAgentViaAPI(request, {
      name: `e2e-harness-${engine.model.split("/")[0]}-${Date.now()}`,
      type: "dispatch",
      model: engine.model,
      cwd: repo,
      useWorktree: true,
      initialPrompt: `kickoff: begin tasks: subagent:`,
    });
    expect(agent.status).toBe("running");

    await loadApp(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await clickAgentRow(page, agent.id);
    await page.getByTestId("center-tab-agent").click();
    const harness = page.getByTestId("harness-pane");
    await expect(harness).toBeVisible();

    // The kickoff ran as the first turn; the persona prefix (for engines
    // that take it that way) is not shown, the launch post is.
    await expect(harness.getByTestId("harness-prompt").first()).toContainText(
      "kickoff: begin",
      { timeout: 30_000 }
    );
    await expect(harness.getByTestId("harness-result").first()).toContainText(
      "You said:",
      { timeout: 30_000 }
    );

    // The tasks strip shows for engines that publish a plan, and only them.
    if (engine.plan) {
      await expect(harness.getByTestId("harness-tasks")).toContainText(
        "1 of 3 done",
        { timeout: 30_000 }
      );
    } else {
      await expect(harness.getByTestId("harness-tasks")).toHaveCount(0);
    }

    // A Claude subagent's steps nest under the Task step.
    if (engine.nested) {
      await harness.getByTestId("harness-activity-summary").first().click();
      const task = harness
        .getByTestId("harness-step")
        .filter({ hasText: "task" })
        .first();
      await task.click();
      await expect(harness.getByTestId("harness-nested-steps")).toBeVisible();
    }

    // The model chip is disabled with a reason for an engine that fixes its model.
    const chip = harness.getByTestId("harness-model-chip");
    if (engine.chipFixed) {
      await expect(chip).toHaveAttribute("data-fixed", "true");
      await expect(chip).toHaveAttribute("title", /sets its model at launch/);
    } else {
      await expect(chip).not.toHaveAttribute("data-fixed", "true");
    }

    // The usage dialog names the engine and says what it reports.
    await harness.getByTestId("harness-usage-chip").click();
    const row = page.getByTestId(
      `harness-usage-engine-${engine.model.split("/")[0]}`
    );
    await expect(row).toBeVisible();
    if (engine.cost) await expect(row).toContainText("$");
    else if (engine.model.startsWith("gemini"))
      await expect(row).toContainText("not reported over ACP");
    else await expect(row).toContainText("no cost reported");
    await page.keyboard.press("Escape");

    // Slash menu lists the engine's commands.
    const input = harness.getByTestId("chat-composer-input");
    await input.fill("/rev");
    await expect(
      harness.getByTestId("chat-composer-slash-item").first()
    ).toContainText("review");
    await input.fill("");
  });
}
```

(The slash item test id is whatever `chat-composer.tsx` renders for slash rows; `grep -n data-testid apps/web/src/components/app/chat/chat-composer.tsx | grep -i slash` names it.)

- [ ] **Step 3: Run the harness spec live**

Run: `E2E_AGENT_RUNTIME=tmux bash scripts/e2e-isolated.sh --no-deps e2e/harness-agent.spec.ts`
Expected: the four engine tests and the two engine-independent tests pass. A failure in only one engine points at that engine's row in the fixture profile or in `agent-spec.ts`.

- [ ] **Step 4: Full e2e**

Run: `pnpm run test:e2e`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add -A e2e
git commit -m "test(e2e): drive the harness once per engine against the fake ACP agent

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Operator docs

**Files:**

- Modify: `docs/10-operations-runbook.md:65-91,245-247`
- Modify: `docs/agent-model-catalog.md:93-end`
- Modify: `update-migrations/0012-agent-stream-events.yaml`
- Delete: `docs/superpowers/specs/2026-09-04-dsh-harness-design.md`, `2026-09-04-dsh-harness-view-design.md`, `docs/superpowers/plans/2026-09-04-dsh-harness.md`, `2026-09-04-dsh-harness-view.md`, `2026-09-05-harness-generative-ui-followups.md`, `docs/superpowers/handoffs/2026-09-05-dsh-harness-handoff.md`
- Modify: `docs/linked-instances-plan.md` (the one dsh mention; reword to "harness")

- [ ] **Step 1: Runbook**

Replace the "Read this first" section (lines 65 to 91) with:

```markdown
### Read this first: a restart cuts a running Dispatch Harness turn

A restart is not free for Dispatch Harness agents (type `dispatch`) the way
it is for CLI agents. A Claude or Codex agent in a tmux pane runs in a
session the service does not own, so `systemctl --user restart` leaves it
working and the new process re-attaches. A Dispatch Harness agent's engine
runs as a **child of the service over stdio** (the Agent Client Protocol
needs a live pipe to its client), so every restart, deploys included, ends
the turn it was running.

What the service does about it:

- At shutdown the running turn is marked `interrupted by restart`; the Harness
  view shows it as interrupted.
- At boot the agent is resumed on its stored session id with `session/resume`.
  If the cut was within the last hour and the agent had not already reported
  done, blocked, or waiting, it receives a `--- DISPATCH: RESTART ---` notice
  and picks the task up from its own history. Chat messages still queued at
  shutdown are delivered again, in order.

Before a restart, check the sidebar for a Dispatch Harness agent that is
`Working` and either wait for the turn or accept the cut.

### Dispatch Harness engines

The engine is the first segment of the agent's model id. Each is a host
install the service resolves with its own `PATH`, not a login shell's, so
set every binary to an absolute path. Each engine uses the host CLI's own
login; Dispatch holds no provider key.

| Engine      | Model id prefix | Binary setting                | Install                                                                         | Login, as the service user  |
| ----------- | --------------- | ----------------------------- | ------------------------------------------------------------------------------- | --------------------------- |
| Claude Code | `claude/`       | `DISPATCH_CLAUDE_HARNESS_BIN` | `npm install -g --prefix ~/.local @agentclientprotocol/claude-agent-acp@0.70.0` | `claude /login`             |
| Codex       | `codex/`        | `DISPATCH_CODEX_HARNESS_BIN`  | `npm install -g --prefix ~/.local @agentclientprotocol/codex-acp@1.7.0`         | `codex login --device-auth` |
| Gemini CLI  | `gemini/`       | `DISPATCH_GEMINI_BIN`         | `npm install -g --prefix ~/.local @google/gemini-cli@0.57.0`                    | `NO_BROWSER=true gemini`    |
| OpenCode    | `opencode/`     | `DISPATCH_OPENCODE_BIN`       | `npm install -g --prefix ~/.local opencode-ai@1.18.29`                          | `opencode auth login`       |

What each engine publishes over ACP differs, and the view says so where it
matters: Gemini CLI publishes no plan, no usage, and no model option (its
model is a launch flag, so `/model` is disabled); Codex reports tokens but
no cost; OpenCode publishes no plan. Claude Code nests a subagent's steps;
the others show a subagent as one step.
```

Replace the three env-table rows (245 to 247) with:

```markdown
| `DISPATCH_CLAUDE_HARNESS_BIN` | `claude-agent-acp` | The Claude engine's ACP adapter. Absolute path. |
| `DISPATCH_CODEX_HARNESS_BIN` | `codex-acp` | The Codex engine's ACP adapter. Absolute path. |
| `DISPATCH_GEMINI_BIN` | `gemini` | Gemini CLI, which speaks ACP itself. Absolute path. |
| `DISPATCH_OPENCODE_BIN` | `opencode` | OpenCode, which speaks ACP itself (`opencode acp`). Absolute path. |
| `DISPATCH_CLAUDE_BIN` | `claude` | Existing. Also handed to the Claude adapter as `CLAUDE_CODE_EXECUTABLE`. |
| `DISPATCH_CODEX_BIN` | `codex` | Existing. Handed to the Codex adapter as `CODEX_PATH` only when set; otherwise the adapter runs its bundled Codex. |
```

- [ ] **Step 2: Model catalog**

Replace the section from `## dsh (DeepSeek Harness)` to the end of `docs/agent-model-catalog.md` with:

```markdown
## Dispatch Harness engines

`dispatch` ids are `engine/model`. The create dialog lists the ids in
`apps/server/src/shared/agent-models.ts`; a running session's picker reads
the engine's own `model` config option, which is authoritative.

| Engine      | Where the list comes from           | Procedure                                                                                                                                                             |
| ----------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `claude` binary                     | The four current ids from Claude Code's documented models; `claude/default` leaves the choice to Claude Code.                                                         |
| Codex       | the `codex` catalog above, prefixed | Keep the two lists in step.                                                                                                                                           |
| Gemini CLI  | the CLI bundle's model literals     | `grep -oE '"gemini-[0-9][a-z0-9.-]+"' $(dirname $(readlink -f $(which gemini)))/../bundle/*.js \| sort -u`; the default is `DEFAULT_GEMINI_MODEL` in the same bundle. |
| OpenCode    | the session                         | Only `opencode/default` is listed; OpenCode publishes its `provider/model` choices once a session runs.                                                               |
```

- [ ] **Step 3: Assisted-update manifest**

Rewrite `update-migrations/0012-agent-stream-events.yaml` so `summary`, `alreadySatisfied.description`, `instructions`, and `rollback` say: the release adds `agent_stream_events` (additive, guarded, with a `plan` kind) and `agent_chat_messages.delivery_text`; the `dispatch` type runs four engines over ACP; a running harness agent shows "Harness session resumed." or an error naming the engine's login command; rollback is the normal release rollback and the tables are harmless to leave. Delete every sentence about `0048`-`0054` renumbering and `forgot 4 legacy` rows. Validate:

```bash
pnpm tsx bin/embed-assisted-update.ts --check-only --metadata update-migrations/0012-agent-stream-events.yaml
```

Expected: the check passes (the file is metadata for an update that already shipped its table; the check confirms shape).

- [ ] **Step 4: Delete the dsh-era design docs and commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git rm -q docs/superpowers/specs/2026-09-04-dsh-harness-design.md docs/superpowers/specs/2026-09-04-dsh-harness-view-design.md \
  docs/superpowers/plans/2026-09-04-dsh-harness.md docs/superpowers/plans/2026-09-04-dsh-harness-view.md \
  docs/superpowers/plans/2026-09-05-harness-generative-ui-followups.md docs/superpowers/handoffs/2026-09-05-dsh-harness-handoff.md
sed -i 's/\bdsh\b/the harness/g' docs/linked-instances-plan.md
grep -rniE '\bdsh\b|deepseek' docs update-migrations README.md || echo "docs clean"
git add -A docs update-migrations
git commit -m "docs: the Dispatch Harness engines for operators

Runbook gains the engine table with install and login per engine and
the env settings; the model catalog names where each engine's list comes
from; the assisted-update manifest describes the shipped migrations. The
dsh-era specs, plans and handoff are removed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Expected grep output: `docs clean`.

---

### Task 4: Release notes, version, tag, build

**Files:**

- Modify: `release-notes/current.md`
- Modify: the six version manifests

- [ ] **Step 1: Release notes**

Replace everything under `### Dispatch Harness patch (dsh)` in `release-notes/current.md` with a section headed `### Dispatch Harness` containing:

```markdown
- **Dispatch Harness**: a `dispatch` agent type that runs a coding agent as a child process over the Agent Client Protocol and renders the session as turns in the new **Harness** view: prompt line, a collapsible activity rail per turn (tool calls with output, diffs, locations, live timers, nested subagent steps), the result, a visible queue with Send now and Remove, Stop and Ctrl+C, a tasks strip, a slash menu of the engine's commands, and a `/usage` dialog. Opt-in via Settings, Agent types.
- **Four engines**, chosen by the model id prefix: `claude/` (Claude Code through `claude-agent-acp`), `codex/` (Codex through `codex-acp`), `gemini/` (Gemini CLI), `opencode/` (OpenCode). Each uses the host CLI's own login; Dispatch holds no provider key. Install and login steps are in the runbook.
- Where an engine publishes nothing over ACP the view says so: Gemini CLI has no tasks strip, reports no usage, and sets its model at launch; Codex reports tokens without cost; OpenCode publishes no plan.
- Restart resilience: a turn a service restart cut short is marked interrupted, the agent resumes on `session/resume` at boot, queued chat is redelivered, and the agent is told to continue.
- Motion: every transition in the Harness view moves on one set of tokens and collapses under reduced motion.
- Schema: `agent_stream_events` (additive) and `agent_chat_messages.delivery_text` (additive), both guarded.
- Settings: **Usage budgets** takes a monthly USD amount for the engines that report cost (Claude Code, OpenCode).
```

- [ ] **Step 2: Version, tag, build**

```bash
cd /home/nii/.dispatch/server-dsh-harness
for f in package.json apps/server/package.json apps/web/package.json packages/shared/package.json apps/browser-extension/package.json apps/browser-extension/public/manifest.json; do
  sed -i -E '0,/"version": "[^"]+"/s//"version": "0.38.13-harness.1"/' "$f"; grep -m1 '"version"' "$f"
done
git add -A release-notes package.json apps packages
git commit -m "Release v0.38.13-harness.1

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git tag v0.38.13-harness.1
pnpm install && pnpm run build:web && pnpm --filter @dispatch/server prepare:runtime-assets && DISPATCH_BUN_TARGETS=bun-linux-x64 pnpm run build:bun
ls -la dist/bun/
```

Expected: `dist/bun/dispatch-0.38.13-harness.1-bun-linux-x64` and `SHA256SUMS.txt`.

---

### Task 5: Live smoke on an isolated stack

Host prerequisites, run as `nii` (each is idempotent):

```bash
npm install -g --prefix ~/.local @agentclientprotocol/claude-agent-acp@0.70.0 @agentclientprotocol/codex-acp@1.7.0 @google/gemini-cli@0.57.0
ls -la ~/.local/bin/claude-agent-acp ~/.local/bin/codex-acp ~/.local/bin/gemini
test -f ~/.claude/.credentials.json && echo "claude: logged in"
codex login --device-auth      # ChatGPT plan; follow the code prompt once
NO_BROWSER=true gemini          # Google account on the company plan; paste the URL, then the code
```

(OpenCode is not installed and its live smoke is skipped by decision Q5.)

- [ ] **Step 1: Start the stack with the real engines**

Use the `repo_dev_up` MCP tool with env `DISPATCH_CLAUDE_HARNESS_BIN=/home/nii/.local/bin/claude-agent-acp`, `DISPATCH_CODEX_HARNESS_BIN=/home/nii/.local/bin/codex-acp`, `DISPATCH_GEMINI_BIN=/home/nii/.local/bin/gemini`, `DISPATCH_CLAUDE_BIN=/home/nii/.local/bin/claude`. Note the printed URLs.

- [ ] **Step 2: Per engine, in the UI**

For `claude/default`, `codex/default`, and `gemini/default` in turn: enable the `dispatch` type, create an agent with a small repo, send "Read README.md and list the files under src, then write a three-item plan", and check: the first turn shows the launch post and the result; a tool step with a location; for Claude and Codex the tasks strip; for Claude a `Task` step with nested children after "use a subagent to summarize README.md"; `/model` opens the picker (disabled with reason for Gemini); `/usage` shows the engine's row; Stop cuts a running turn and marks it interrupted; `repo_dev_restart`, then the agent resumes and a queued message is redelivered. Capture one screenshot per engine with the Playwright MCP and share each with `dispatch_share_file`. Call `browser_close` when done.

- [ ] **Step 3: Record**

Add a short "Live smoke, 2026-09-xx" note to the PR body (Task 6) listing, per engine, what worked and what did not, with the exact stderr line from `repo_dev_logs` for anything that did not.

---

### Task 6: The pull request

- [ ] **Step 1: Push the branch and update #1067**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git push origin dsh-harness-deploy:agt_683b115bc1e9/dispatch-harness-research --force-with-lease
git push origin v0.38.13-harness.1
```

Update the PR's title to `feat: Dispatch Harness, an ACP agent type with four engines and a turn-stream view` and its body with the four-part structure from `mytra-write-for-review` (Summary; Changes with paths; Test plan; Checklist), the icon candidate sheet attached under Changes, and the live-smoke note from Task 5. Use the `create_pr` MCP tool if it updates an existing PR; otherwise `gh pr edit 1067 --title ... --body-file ...`.

- [ ] **Step 2: Host cleanup (operational, after Nii says so)**

```bash
npm rm -g --prefix ~/.local @deepseek-ai/dsh
rm -rf ~/.dispatch/dsh
```

Deploying `v0.38.13-harness.1` to the production install is a separate decision for Nii; the recipe is in the memory note `dispatch-prod-deploy-on-this-host`.

---

## Self-review against the spec

| Spec section                                                        | Task    |
| ------------------------------------------------------------------- | ------- |
| Tests: e2e fixture with capability profiles, once per engine        | 1, 2    |
| Tests: Playwright reduced motion                                    | 2       |
| Tests: live smoke (Claude, Codex, Gemini; OpenCode skipped)         | 5       |
| Configuration: runbook install and login steps                      | 3       |
| Docs touched (runbook, catalog, release notes, update manifest, PR) | 3, 4, 6 |
| What changes: dsh-era docs deleted                                  | 3       |
| Prerelease tags `0.38.13-harness.N`                                 | 4       |
| Host cleanup                                                        | 6       |

Placeholder scan: none. Type consistency: `data-testid` names (`harness-tasks`, `harness-nested-steps`, `harness-model-chip` with `data-fixed`, `harness-usage-engine-<id>`) match plan 2.
