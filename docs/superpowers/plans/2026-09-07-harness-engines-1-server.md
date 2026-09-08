# Dispatch Harness engines, plan 1 of 3: server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dsh child process behind the `dispatch` agent type with four ACP engines (Claude Code, Codex, Gemini CLI, OpenCode) chosen by the model id prefix, and delete every server module that assumed dsh.

**Architecture:** The ACP driver, supervisor, stream recorder, turn assembler and routes keep their shape (see the spec, `docs/superpowers/specs/2026-09-07-dispatch-harness-acp-engines-design.md`). A new `agent-spec.ts` holds one spec per engine (binary, arguments, environment, persona delivery, full-access mechanism, subagent negotiation); the supervisor reads the engine from `agent.model`, the driver spawns whatever the spec says, the recorder learns three more ACP update kinds (`plan`, `plan_update`, `usage_update`) and one `_meta` field (`claudeCode.parentToolUseId`). Everything dsh-specific (overlay, zstd session logs, credential store, price table, command log, skills scan) is deleted. Plan 2 does the web, plan 3 the e2e fixture, docs and release.

**Tech Stack:** TypeScript (ESM), Fastify, `@agentclientprotocol/sdk@1.4.0` (v1 schema, root export), node-pg-migrate, Vitest (server tests run through `scripts/server-tests-isolated.sh`), pnpm.

## Global Constraints

- Every ACP kind the recorder handles is in the SDK's v1 schema: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `plan_update`, `plan_removed`, `usage_update`, `config_option_update`, `available_commands_update`. `current_mode_update`, `session_info_update`, `user_message_chunk`, `compaction_update`, `compaction_summary_chunk` are ignored.
- The driver resumes with `session/resume` (`conn.resumeSession`), never `session/load`: `session/load` replays the whole history as updates and the recorder would re-record it.
- The engine is the first segment of the model id. `claude/default` is the default. Model ids without a slash are rejected at create time.
- Persona delivery: `claude` gets `session/new` and `session/resume` `_meta.systemPrompt: { append }`; `codex`, `gemini`, `opencode` get the persona as the leading block of the first `session/prompt` of a fresh session, never of a resumed one.
- Full access: `claude` `--dangerously-skip-permissions`; `codex` `INITIAL_AGENT_MODE=agent-full-access`; `gemini` `session/set_mode` to `yolo` after the session opens; `opencode` through the driver's `requestPermission` handler, which answers `allow_once` or `allow_always`.
- Subagent transcripts: only `claude` declares `_meta: { "subagent-transcript": true }` in `clientCapabilities`; nested tool calls carry `_meta.claudeCode.parentToolUseId`.
- No `DSH_*` environment variable, no `dshBin`, no `dshHome`, no `DISPATCH_DSH_*` remains anywhere under `apps/`, `packages/`, `e2e/`, `scripts/`, `update-migrations/`.
- Copy rules: American spelling; no em-dashes in prose or comments; user-facing strings name the engine ("Claude Code", "Codex", "Gemini CLI", "OpenCode") or say "the harness", never "dsh".
- Commit messages: `type(scope): imperative subject`, lowercase after the colon, body wrapped at 72, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Server tests: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run <file>`; type check: `pnpm --filter @dispatch/server check`. The repo-wide `pnpm run check` passes only after plan 2, because plan 1 keeps the shared types the web still imports (marked `@deprecated`) and plan 2 removes them.
- Worktree: `/home/nii/.dispatch/server-dsh-harness`, branch `dsh-harness-deploy`. Never touch `/home/nii/.dispatch/server` (the production install).

---

## File structure

| Path                                                                                                       | Responsibility after this plan                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/agents/harness/agent-spec.ts`                                                             | **New.** The engine table: `HARNESS_ENGINE_IDS`, `splitModelId`, `engineSpecFor`, `DEFAULT_MODEL`. Pure data and one function; no I/O.                                                  |
| `apps/server/src/agents/harness/driver.ts`                                                                 | Renamed from `dsh/driver.ts`. `HarnessDriver`: spawns the engine's binary with the spec's arguments and env, speaks ACP, holds live config options and commands.                        |
| `apps/server/src/agents/harness/supervisor.ts`                                                             | Renamed. `HarnessSupervisor`: picks the engine, delivers the persona per spec, queues turns, applies the model, restores at boot.                                                       |
| `apps/server/src/agents/harness/stream-recorder.ts`                                                        | Renamed. Folds updates into rows; gains `plan`, `usage_update`, `parentToolCallId`.                                                                                                     |
| `apps/server/src/agents/harness/stream-store.ts`                                                           | Renamed. Row kinds gain `plan`; payload types gain `PlanPayload`, `ToolPayload.parentToolCallId`, `TurnPayload.usage`.                                                                  |
| `apps/server/src/agents/harness/turns.ts`                                                                  | Renamed. Nests child steps under their parent, carries `plan` and `usage` on the turn.                                                                                                  |
| `apps/server/src/agents/harness/usage.ts`                                                                  | **New.** Month-to-date tokens (from `agent_token_usage`) and USD (from turn rows) per engine and agent.                                                                                 |
| `apps/server/src/agents/harness/usage-recorder.ts`                                                         | Renamed, unchanged: writes the prompt response's cumulative `Usage` into `agent_token_usage`. Engine-agnostic, so it stays (a correction to the spec's delete list).                    |
| `apps/server/src/agents/harness/persona.ts`, `prompt-source.ts`, `paths.ts`                                | Renamed; identifiers renamed; wording updated.                                                                                                                                          |
| `apps/server/src/routes/agents/harness-routes.ts`                                                          | `/commands` replaces `/skills`; per-agent `/usage`; the subagent route is deleted.                                                                                                      |
| `apps/server/src/routes/system.ts`                                                                         | `/api/v1/agent-models` is static again; `/api/v1/harness/usage` reads `usage.ts`.                                                                                                       |
| `apps/server/src/usage-budget-settings.ts`                                                                 | Budget keys are the cost-reporting engine ids.                                                                                                                                          |
| `apps/server/src/config.ts`                                                                                | `claudeHarnessBin`, `codexHarnessBin`, `geminiBin` added; `dshBin`, `dshHome` removed.                                                                                                  |
| `apps/server/src/shared/agent-models.ts`                                                                   | The `dispatch` catalog lists engine-prefixed ids.                                                                                                                                       |
| `apps/server/src/db/migrations/0051_agent-stream-events.sql`, `0052_agent-chat-messages-delivery-text.sql` | The two guarded harness migrations; `0053` and `0054` are gone.                                                                                                                         |
| `apps/server/src/db/migrate.ts`                                                                            | `forgetLegacyMigrations` removed.                                                                                                                                                       |
| `packages/shared/src/harness-types.ts`                                                                     | `HARNESS_ENGINES`, `HarnessCommand`, `HarnessStep.children`, `HarnessTurn.plan`, `HarnessTurn.usage`, the new `HarnessUsageResponse`; dsh-era types kept as `@deprecated` until plan 2. |
| Deleted                                                                                                    | `agents/dsh/{overlay,session-log,subagents,usage,codex-usage,usage-http,credentials,command-log,skills}.ts` and their tests; `test/bun-session-log.smoke.ts`.                           |

---

### Task 1: Rename the module and every dsh identifier

The rename is mechanical and touches ~90 files, so it goes first and alone: every later task then edits files that already have their final names. Nothing behavioral changes; the existing suites must still pass at the end.

**Files:**

- Move: `apps/server/src/agents/dsh/` → `apps/server/src/agents/harness/`
- Move: `apps/server/test/dsh-*.test.ts` → `apps/server/test/harness-*.test.ts`
- Modify: every importer under `apps/server/src`, `apps/server/test`, `e2e/`

**Interfaces:**

- Produces: `HarnessDriver` (was `DshDriver`), `HarnessSupervisor` (was `DshSupervisor`), `buildHarnessPersona` (was `buildDshPersona`), `HARNESS_CHAT_RULE`, `HARNESS_SLASH_RULE`, `AgentPromptTarget` variant `{ kind: "harness"; busy: boolean }`, `AgentManager.attachHarnessSupervisor`, `promptHarness`, `listRunningHarnessAgentIds`, `markHarnessExited`, `markHarnessStartFailed`, `buildHarnessPersonaFor`; `server.ts` local `harnessSupervisor`.

- [ ] **Step 1: Move the module and the test files**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git mv apps/server/src/agents/dsh apps/server/src/agents/harness
for f in apps/server/test/dsh-*.test.ts; do git mv "$f" "${f/dsh-/harness-}"; done
```

- [ ] **Step 2: Rewrite import paths and identifiers**

```bash
cd /home/nii/.dispatch/server-dsh-harness
FILES=$(grep -rlE 'agents/dsh/|DshDriver|DshSupervisor|buildDshPersona|DSH_CHAT_RULE|DSH_SLASH_RULE|attachDshSupervisor|promptDsh\b|listRunningDshAgentIds|markDshExited|markDshStartFailed|buildDshPersonaFor|dshSupervisor|kind: "dsh"|"\./dsh/|\.\./dsh/' apps/server/src apps/server/test e2e --include='*.ts' --include='*.tsx' --include='*.mjs')
sed -i \
  -e 's#agents/dsh/#agents/harness/#g' \
  -e 's#"\./dsh/#"./harness/#g' \
  -e 's#"\.\./dsh/#"../harness/#g' \
  -e 's/\bDshDriver\b/HarnessDriver/g' \
  -e 's/\bDshSupervisor\b/HarnessSupervisor/g' \
  -e 's/\bbuildDshPersona\b/buildHarnessPersona/g' \
  -e 's/\bDSH_CHAT_RULE\b/HARNESS_CHAT_RULE/g' \
  -e 's/\bDSH_SLASH_RULE\b/HARNESS_SLASH_RULE/g' \
  -e 's/\battachDshSupervisor\b/attachHarnessSupervisor/g' \
  -e 's/\bpromptDsh\b/promptHarness/g' \
  -e 's/\blistRunningDshAgentIds\b/listRunningHarnessAgentIds/g' \
  -e 's/\bmarkDshExited\b/markHarnessExited/g' \
  -e 's/\bmarkDshStartFailed\b/markHarnessStartFailed/g' \
  -e 's/\bbuildDshPersonaFor\b/buildHarnessPersonaFor/g' \
  -e 's/\bdshSupervisor\b/harnessSupervisor/g' \
  -e 's/kind: "dsh"/kind: "harness"/g' \
  $FILES
grep -rn -E 'kind === "dsh"' apps/server/src | cut -d: -f1 | sort -u | xargs -r sed -i 's/kind === "dsh"/kind === "harness"/g'
```

- [ ] **Step 3: Type check and run the renamed suites**

Run: `cd /home/nii/.dispatch/server-dsh-harness && pnpm --filter @dispatch/server check`
Expected: exit 0, no output besides the `prepare:runtime-assets` line.

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-driver.test.ts test/harness-supervisor.test.ts test/harness-turns.test.ts test/harness-routes.test.ts`
Expected: all four files pass (they exercise the old dsh behavior, unchanged so far).

- [ ] **Step 4: Commit**

```bash
git add -A apps/server e2e
git commit -m "refactor(server): rename the dsh module and identifiers to harness

No behavior change: the module moves to agents/harness and every
Dsh* identifier becomes Harness*, so the engine work that follows
edits files under their final names.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Collapse the migrations to one guarded pair

**Files:**

- Modify: `apps/server/src/db/migrations/0051_agent-stream-events.sql`
- Move: `apps/server/src/db/migrations/0053_agent-chat-messages-delivery-text.sql` → `0052_agent-chat-messages-delivery-text.sql`
- Delete: `apps/server/src/db/migrations/0052_agent-stream-events-turn.sql`, `0054_agent-type-dispatch.sql`
- Modify: `apps/server/src/db/migrate.ts:14-42,81-86`
- Test: `apps/server/test/migrations-harness.test.ts` (new); delete any test importing `forgetLegacyMigrations` or `LEGACY_MIGRATION_NAMES`

**Interfaces:**

- Produces: the `agent_stream_events.kind` check accepts `'plan'`; `agent_chat_messages.delivery_text` exists.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/migrations-harness.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
});

describe("harness migrations", () => {
  it("run twice without error (every statement is guarded)", async () => {
    await expect(runTestMigrations()).resolves.not.toThrow();
  });

  it("accept a plan row and a delivery_text column", async () => {
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status) VALUES ('agt_mig', 'M', '/tmp', 'running')`
    );
    await expect(
      pool.query(
        `INSERT INTO agent_stream_events (agent_id, seq, kind, key, payload)
         VALUES ('agt_mig', 1, 'plan', 'plan:1', '{"entries":[]}'::jsonb)`
      )
    ).resolves.toBeDefined();
    const column = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agent_chat_messages' AND column_name = 'delivery_text'`
    );
    expect(column.rowCount).toBe(1);
  });

  it("carries no migration named after the old dsh files", async () => {
    const rows = await pool.query<{ name: string }>(
      `SELECT name FROM pgmigrations WHERE name IN
        ('0052_agent-stream-events-turn', '0053_agent-chat-messages-delivery-text', '0054_agent-type-dispatch')`
    );
    expect(rows.rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/migrations-harness.test.ts`
Expected: FAIL. The `plan` insert violates `agent_stream_events_kind_check`, and the third test finds `0052_agent-stream-events-turn` in `pgmigrations`.

- [ ] **Step 3: Rewrite `0051` and rename `0053`**

Replace the whole of `apps/server/src/db/migrations/0051_agent-stream-events.sql` with:

```sql
-- The Dispatch Harness stream: one row per assistant text, thought, tool
-- call, status line, turn, or plan, folded from Agent Client Protocol
-- session updates. Every statement is guarded so the file re-runs as a
-- no-op on an install whose table predates it; the constraint is replaced
-- rather than created because an older table may carry it without 'plan'.
CREATE TABLE IF NOT EXISTS agent_stream_events (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  key         TEXT,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_stream_events_agent_key
  ON agent_stream_events (agent_id, kind, key)
  WHERE key IS NOT NULL;

ALTER TABLE agent_stream_events DROP CONSTRAINT IF EXISTS agent_stream_events_kind_check;
ALTER TABLE agent_stream_events
  ADD CONSTRAINT agent_stream_events_kind_check
  CHECK (kind IN ('assistant', 'thought', 'tool_call', 'status', 'turn', 'plan'));
```

Then:

```bash
cd /home/nii/.dispatch/server-dsh-harness/apps/server/src/db/migrations
git rm -q 0052_agent-stream-events-turn.sql 0054_agent-type-dispatch.sql
git mv 0053_agent-chat-messages-delivery-text.sql 0052_agent-chat-messages-delivery-text.sql
```

`0052_agent-chat-messages-delivery-text.sql` keeps its body:

```sql
ALTER TABLE agent_chat_messages ADD COLUMN IF NOT EXISTS delivery_text TEXT;
```

- [ ] **Step 4: Remove the legacy cleanup from `migrate.ts`**

In `apps/server/src/db/migrate.ts` delete lines 14 to 42 (the comment block, `LEGACY_MIGRATION_NAMES`, and `forgetLegacyMigrations`) and lines 81 to 86 (the call and its log). The lock section becomes:

```ts
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);

    await runner({
```

Delete every test that imports the removed symbols:

```bash
cd /home/nii/.dispatch/server-dsh-harness
grep -rlE 'forgetLegacyMigrations|LEGACY_MIGRATION_NAMES' apps/server/test | xargs -r git rm -q
```

- [ ] **Step 5: Run the test to see it pass**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/migrations-harness.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A apps/server/src/db apps/server/test
git commit -m "feat(db): collapse the harness migrations to one guarded pair

0051 creates agent_stream_events and replaces its kind check so 'plan'
rows are accepted on a table that predates them; 0052 adds
delivery_text. The dsh-era renumbering shim in migrate.ts goes with the
files it existed for.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Shared types for engines, commands, plans, usage

**Files:**

- Modify: `packages/shared/src/harness-types.ts`
- Modify: `packages/shared/src/index.ts` (exports)
- Test: `packages/shared/src/harness-types.test.ts` (new, plain Vitest under `packages/shared` if it has a config; otherwise `apps/server/test/harness-engines-shared.test.ts`)

**Interfaces:**

- Produces:

```ts
export const HARNESS_ENGINE_IDS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
] as const;
export type HarnessEngineId = (typeof HARNESS_ENGINE_IDS)[number];
export type HarnessEngine = {
  id: HarnessEngineId;
  label: string; // "Claude Code" | "Codex" | "Gemini CLI" | "OpenCode"
  publishesPlan: boolean; // claude, codex
  publishesModelOption: boolean; // claude, codex, opencode
  reportsUsage: boolean; // claude, codex, opencode
  reportsCost: boolean; // claude, opencode
  loginCommand: string; // shown when auth_required
};
export const HARNESS_ENGINES: readonly HarnessEngine[];
export function harnessEngineOf(
  modelId: string | null | undefined
): HarnessEngine | null;
export const DEFAULT_HARNESS_MODEL = "claude/default";
export type HarnessCommand = {
  name: string;
  description: string;
  input?: { hint: string } | null;
};
export type HarnessCommandsResponse = { commands: HarnessCommand[] };
export type HarnessPlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
};
// HarnessStep gains: children?: HarnessStep[]; detail.parentToolCallId?: string
// HarnessTurn gains: plan?: HarnessPlanEntry[]; usage?: { used: number; size: number; costUsd: number | null }
export type HarnessUsageAgent = {
  agentId: string;
  name: string;
  tokens: number;
  costUsd: number | null;
};
export type HarnessUsageEngine = HarnessEngine & {
  tokens: number;
  costUsd: number | null;
  budgetUsd: number | null;
  agents: HarnessUsageAgent[];
};
export type HarnessUsageResponse = {
  generatedAt: string;
  monthStart: string;
  engines: HarnessUsageEngine[];
};
export type UsageBudgets = Partial<Record<"claude" | "opencode", number>>;
```

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/harness-engines-shared.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HARNESS_MODEL,
  HARNESS_ENGINES,
  harnessEngineOf,
} from "@dispatch/shared";

describe("HARNESS_ENGINES", () => {
  it("lists the four engines in create-dialog order", () => {
    expect(HARNESS_ENGINES.map((e) => e.id)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
    ]);
  });

  it("knows which engines publish a plan, a model option, usage, and cost", () => {
    const by = Object.fromEntries(HARNESS_ENGINES.map((e) => [e.id, e]));
    expect(by.claude).toMatchObject({
      publishesPlan: true,
      publishesModelOption: true,
      reportsUsage: true,
      reportsCost: true,
    });
    expect(by.codex).toMatchObject({
      publishesPlan: true,
      publishesModelOption: true,
      reportsUsage: true,
      reportsCost: false,
    });
    expect(by.gemini).toMatchObject({
      publishesPlan: false,
      publishesModelOption: false,
      reportsUsage: false,
      reportsCost: false,
    });
    expect(by.opencode).toMatchObject({
      publishesPlan: false,
      publishesModelOption: true,
      reportsUsage: true,
      reportsCost: true,
    });
  });

  it("resolves an engine from a model id prefix", () => {
    expect(harnessEngineOf("codex/gpt-5.6-sol")?.id).toBe("codex");
    expect(harnessEngineOf("opencode/anthropic/claude-sonnet-5")?.id).toBe(
      "opencode"
    );
    expect(harnessEngineOf(DEFAULT_HARNESS_MODEL)?.id).toBe("claude");
    expect(harnessEngineOf("gpt-5.6-sol")).toBeNull();
    expect(harnessEngineOf("deepseek/x")).toBeNull();
    expect(harnessEngineOf(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-engines-shared.test.ts`
Expected: FAIL, `HARNESS_ENGINES` is not exported by `@dispatch/shared`.

- [ ] **Step 3: Add the types**

In `packages/shared/src/harness-types.ts`, replace the block from `/** A skill the harness can load...` (the `HarnessSkill` and `HarnessSkillsResponse` types) with:

```ts
/**
 * The engines the harness can run. One row per ACP agent; the create
 * dialog, the usage dialog, the budget settings, and the starting screen's
 * login message all read from here. Order is create-dialog order.
 */
export const HARNESS_ENGINE_IDS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
] as const;
export type HarnessEngineId = (typeof HARNESS_ENGINE_IDS)[number];

export type HarnessEngine = {
  id: HarnessEngineId;
  label: string;
  /** Sends ACP `plan` / `plan_update`, so the tasks strip has something to show. */
  publishesPlan: boolean;
  /** Publishes a `model` config option, so `/model` can switch mid-session. */
  publishesModelOption: boolean;
  /** Sends `usage_update` at all. */
  reportsUsage: boolean;
  /** Its `usage_update` carries a USD `cost`. */
  reportsCost: boolean;
  /** What to run as the service user when the engine reports `auth_required`. */
  loginCommand: string;
};

export const HARNESS_ENGINES: readonly HarnessEngine[] = [
  {
    id: "claude",
    label: "Claude Code",
    publishesPlan: true,
    publishesModelOption: true,
    reportsUsage: true,
    reportsCost: true,
    loginCommand: "claude /login",
  },
  {
    id: "codex",
    label: "Codex",
    publishesPlan: true,
    publishesModelOption: true,
    reportsUsage: true,
    reportsCost: false,
    loginCommand: "codex login --device-auth",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    publishesPlan: false,
    publishesModelOption: false,
    reportsUsage: false,
    reportsCost: false,
    loginCommand: "NO_BROWSER=true gemini",
  },
  {
    id: "opencode",
    label: "OpenCode",
    publishesPlan: false,
    publishesModelOption: true,
    reportsUsage: true,
    reportsCost: true,
    loginCommand: "opencode auth login",
  },
];

export const DEFAULT_HARNESS_MODEL = "claude/default";

/** The engine named by a model id's first segment; null when there is none or it is unknown. */
export function harnessEngineOf(
  modelId: string | null | undefined
): HarnessEngine | null {
  if (!modelId) return null;
  const slash = modelId.indexOf("/");
  if (slash <= 0) return null;
  const id = modelId.slice(0, slash);
  return HARNESS_ENGINES.find((e) => e.id === id) ?? null;
}

/** A slash command the engine advertises (`available_commands_update`). */
export type HarnessCommand = {
  name: string;
  description: string;
  input?: { hint: string } | null;
};

export type HarnessCommandsResponse = { commands: HarnessCommand[] };

/** One entry of the agent's task list, as ACP `plan` carries it. */
export type HarnessPlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
};

/** @deprecated The slash menu reads commands now; removed with the web feeds in plan 2. */
export type HarnessSkill = {
  name: string;
  description: string;
  source: "project" | "home";
};

/** @deprecated See HarnessSkill. */
export type HarnessSkillsResponse = { skills: HarnessSkill[] };
```

In the `HarnessStep` type add two fields:

```ts
  detail: {
    // ...existing fields...
    /** A nested call: the toolCallId of the step it runs under. */
    parentToolCallId?: string;
  };
  /** Steps a subagent ran under this one (Claude Task calls). */
  children?: HarnessStep[];
```

In the `HarnessTurn` type add, after `label?: string;`:

```ts
  /** The task list as the engine last published it during this turn. */
  plan?: HarnessPlanEntry[];
  /** Context used and, where the engine reports it, cost so far in this session. */
  usage?: { used: number; size: number; costUsd: number | null };
```

Replace the `HarnessUsageResponse` type and everything from `/** Token counts as the harness logs them...` through `UsageBudgetsResponse` with:

```ts
export type HarnessUsageAgent = {
  agentId: string;
  name: string;
  /** Tokens this month from agent_token_usage (input + output + cache). */
  tokens: number;
  /** USD the engine reported for its sessions this month; null when it reports none. */
  costUsd: number | null;
};

export type HarnessUsageEngine = HarnessEngine & {
  tokens: number;
  costUsd: number | null;
  /** From Settings, Agents, Usage budgets; only cost-reporting engines take one. */
  budgetUsd: number | null;
  agents: HarnessUsageAgent[];
};

export type HarnessUsageResponse = {
  generatedAt: string;
  monthStart: string;
  engines: HarnessUsageEngine[];
};

/** Engines a USD budget applies to: the ones whose usage carries a cost. */
export const HARNESS_BUDGET_ENGINE_IDS = HARNESS_ENGINES.filter(
  (e) => e.reportsCost
).map((e) => e.id) as readonly HarnessEngineId[];

/** Monthly budgets in USD by engine id; an engine without a row has none. */
export type UsageBudgets = Partial<Record<HarnessEngineId, number>>;

export type UsageBudgetsResponse = { budgets: UsageBudgets };

/** @deprecated dsh-era provider registry; removed with the web feeds in plan 2. */
export const HARNESS_USAGE_PROVIDERS = [] as const;
/** @deprecated */
export type HarnessUsageProvider = never;
/** @deprecated */
export type HarnessSubscriptionUsage = never;
/** @deprecated */
export type HarnessTokenCounts = never;
/** @deprecated */
export function harnessProviderLabel(id: string): string {
  return id;
}
/** @deprecated */
export function isHarnessBudgetProvider(): boolean {
  return false;
}
/** @deprecated */
export const HARNESS_BUDGET_PROVIDERS = [] as const;
```

Delete the `HarnessSubagent` and `HarnessSubagentResponse` types (the route is deleted in Task 9; the web stops importing them in plan 2, so keep them as `@deprecated` aliases instead if `check:web` is required to stay green before plan 2):

```ts
/** @deprecated Subagents are nested steps now; removed in plan 2. */
export type HarnessSubagent = {
  id: string;
  status: "starting" | "running" | "finished";
  startedAt: string;
  turns: HarnessTurn[];
  label?: string;
  model?: string;
  endedAt?: string;
  parentSession?: string;
};
/** @deprecated */
export type HarnessSubagentResponse = { subagent: HarnessSubagent };
```

In `packages/shared/src/index.ts`, add to the harness exports: `HARNESS_ENGINE_IDS`, `HARNESS_ENGINES`, `DEFAULT_HARNESS_MODEL`, `harnessEngineOf`, `HARNESS_BUDGET_ENGINE_IDS`, and the types `HarnessEngineId`, `HarnessEngine`, `HarnessCommand`, `HarnessCommandsResponse`, `HarnessPlanEntry`, `HarnessUsageAgent`, `HarnessUsageEngine`. Keep the existing export lines for the deprecated names.

- [ ] **Step 4: Run the test to see it pass**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-engines-shared.test.ts`
Expected: PASS (3 tests).

Run: `pnpm --filter @dispatch/shared build 2>/dev/null || pnpm --filter @dispatch/server check`
Expected: exit 0. (`server.ts` still compiles: it imports nothing removed.)

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/server/test/harness-engines-shared.test.ts
git commit -m "feat(shared): harness engine registry, commands, plan and usage types

HARNESS_ENGINES is the one table the create dialog, usage dialog,
budgets and starting screen read from. Turns carry plan entries and
usage; steps carry children. The dsh-era provider and skill types stay
as deprecated aliases until plan 2 removes their web importers.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `agent-spec.ts`, the engine table

**Files:**

- Create: `apps/server/src/agents/harness/agent-spec.ts`
- Test: `apps/server/test/harness-agent-spec.test.ts`

**Interfaces:**

- Consumes: `HARNESS_ENGINE_IDS`, `HarnessEngineId`, `DEFAULT_HARNESS_MODEL` from `@dispatch/shared`; `AppConfig` from `../../config.js` (Task 10 adds the three new fields; until then the `EngineBins` type below is declared locally, so this task compiles on its own).
- Produces:

```ts
export type EngineBins = {
  claudeHarnessBin: string;
  codexHarnessBin: string;
  geminiBin: string;
  opencodeBin: string;
  /** Absolute path to the host's claude, for CLAUDE_CODE_EXECUTABLE. */
  claudeBin: string;
  /** Absolute path to the host's codex, or null to run the adapter's bundled one. */
  codexBin: string | null;
};
export type FullAccess =
  | { kind: "args" }
  | { kind: "env" }
  | { kind: "set_mode"; modeId: string }
  | { kind: "permission_request" };
export type EngineSpec = {
  id: HarnessEngineId;
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  personaDelivery: "system_prompt" | "first_prompt";
  fullAccess: FullAccess;
  subagentTranscripts: boolean;
  modelFixedAtLaunch: boolean;
};
export function splitModelId(model: string): {
  engine: HarnessEngineId;
  model: string;
};
export function engineSpecFor(
  engine: HarnessEngineId,
  model: string,
  bins: EngineBins
): EngineSpec;
```

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/harness-agent-spec.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  engineSpecFor,
  splitModelId,
  type EngineBins,
} from "../src/agents/harness/agent-spec.js";

const bins: EngineBins = {
  claudeHarnessBin: "/usr/local/bin/claude-agent-acp",
  codexHarnessBin: "/usr/local/bin/codex-acp",
  geminiBin: "/usr/local/bin/gemini",
  opencodeBin: "/usr/local/bin/opencode",
  claudeBin: "/home/u/.local/bin/claude",
  codexBin: null,
};

describe("splitModelId", () => {
  it("splits at the first slash so OpenCode's provider/model survives", () => {
    expect(splitModelId("claude/default")).toEqual({
      engine: "claude",
      model: "default",
    });
    expect(splitModelId("opencode/anthropic/claude-sonnet-5")).toEqual({
      engine: "opencode",
      model: "anthropic/claude-sonnet-5",
    });
  });

  it("rejects ids without an engine or with an unknown one", () => {
    expect(() => splitModelId("gpt-5.6-sol")).toThrow(/engine\/model/);
    expect(() => splitModelId("deepseek/v4")).toThrow(/unknown engine/);
    expect(() => splitModelId("claude/")).toThrow(/engine\/model/);
  });
});

describe("engineSpecFor", () => {
  it("claude: the adapter, skip-permissions, the host claude, system-prompt persona, nested subagents", () => {
    const spec = engineSpecFor("claude", "default", bins);
    expect(spec).toMatchObject({
      id: "claude",
      bin: "/usr/local/bin/claude-agent-acp",
      args: ["--dangerously-skip-permissions"],
      env: { CLAUDE_CODE_EXECUTABLE: "/home/u/.local/bin/claude" },
      personaDelivery: "system_prompt",
      fullAccess: { kind: "args" },
      subagentTranscripts: true,
      modelFixedAtLaunch: false,
    });
  });

  it("codex: full access by env, bundled codex unless a host codex is configured", () => {
    expect(engineSpecFor("codex", "gpt-5.6-sol", bins)).toMatchObject({
      bin: "/usr/local/bin/codex-acp",
      args: [],
      env: { INITIAL_AGENT_MODE: "agent-full-access", NO_BROWSER: "1" },
      personaDelivery: "first_prompt",
      fullAccess: { kind: "env" },
      subagentTranscripts: false,
    });
    expect(
      engineSpecFor("codex", "default", { ...bins, codexBin: "/bin/codex" }).env
    ).toMatchObject({ CODEX_PATH: "/bin/codex" });
    expect(engineSpecFor("codex", "default", bins).env).not.toHaveProperty(
      "CODEX_PATH"
    );
  });

  it("gemini: the acp flag, the model as a launch flag, yolo by set_mode", () => {
    expect(engineSpecFor("gemini", "gemini-3-pro-preview", bins)).toMatchObject(
      {
        bin: "/usr/local/bin/gemini",
        args: ["--experimental-acp", "--model", "gemini-3-pro-preview"],
        env: {},
        personaDelivery: "first_prompt",
        fullAccess: { kind: "set_mode", modeId: "yolo" },
        modelFixedAtLaunch: true,
      }
    );
    expect(engineSpecFor("gemini", "default", bins).args).toEqual([
      "--experimental-acp",
    ]);
  });

  it("opencode: the acp subcommand, permissions answered by the driver", () => {
    expect(engineSpecFor("opencode", "default", bins)).toMatchObject({
      bin: "/usr/local/bin/opencode",
      args: ["acp"],
      env: {},
      personaDelivery: "first_prompt",
      fullAccess: { kind: "permission_request" },
      subagentTranscripts: false,
      modelFixedAtLaunch: false,
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-agent-spec.test.ts`
Expected: FAIL, cannot find module `../src/agents/harness/agent-spec.js`.

- [ ] **Step 3: Write the module**

Create `apps/server/src/agents/harness/agent-spec.ts`:

```ts
import { HARNESS_ENGINE_IDS, type HarnessEngineId } from "@dispatch/shared";

/**
 * One row per engine the harness can run: what to spawn, how it gets full
 * access, how the persona reaches it, and what it negotiates. The
 * supervisor picks a row from the agent's model id; the driver spawns what
 * the row says and knows nothing else about the engine.
 */

export type EngineBins = {
  claudeHarnessBin: string;
  codexHarnessBin: string;
  geminiBin: string;
  opencodeBin: string;
  /** Absolute path to the host's `claude`, for `CLAUDE_CODE_EXECUTABLE`. */
  claudeBin: string;
  /** Absolute path to the host's `codex`, or null to run the adapter's bundled one. */
  codexBin: string | null;
};

export type FullAccess =
  /** Already in `args`. */
  | { kind: "args" }
  /** Already in `env`. */
  | { kind: "env" }
  /** `session/set_mode` to this mode id right after the session opens. */
  | { kind: "set_mode"; modeId: string }
  /** The agent asks per call; the driver's requestPermission handler allows. */
  | { kind: "permission_request" };

export type EngineSpec = {
  id: HarnessEngineId;
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /**
   * `system_prompt`: `session/new` and `session/resume` carry
   * `_meta.systemPrompt.append`. `first_prompt`: the persona is the leading
   * block of a fresh session's first prompt.
   */
  personaDelivery: "system_prompt" | "first_prompt";
  fullAccess: FullAccess;
  /** Declare `_meta["subagent-transcript"]` at initialize and nest by parentToolUseId. */
  subagentTranscripts: boolean;
  /** The model is a launch flag, so `/model` cannot switch it. */
  modelFixedAtLaunch: boolean;
};

const ENGINE_IDS: readonly string[] = HARNESS_ENGINE_IDS;

/** `engine/model` at the first slash; the model half may itself contain slashes. */
export function splitModelId(model: string): {
  engine: HarnessEngineId;
  model: string;
} {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`harness model ids are engine/model; got "${model}"`);
  }
  const engine = model.slice(0, slash);
  if (!ENGINE_IDS.includes(engine)) {
    throw new Error(`unknown engine "${engine}" in model id "${model}"`);
  }
  return { engine: engine as HarnessEngineId, model: model.slice(slash + 1) };
}

export function engineSpecFor(
  engine: HarnessEngineId,
  model: string,
  bins: EngineBins
): EngineSpec {
  switch (engine) {
    case "claude":
      return {
        id: engine,
        bin: bins.claudeHarnessBin,
        args: ["--dangerously-skip-permissions"],
        env: { CLAUDE_CODE_EXECUTABLE: bins.claudeBin },
        personaDelivery: "system_prompt",
        fullAccess: { kind: "args" },
        subagentTranscripts: true,
        modelFixedAtLaunch: false,
      };
    case "codex":
      return {
        id: engine,
        bin: bins.codexHarnessBin,
        args: [],
        env: {
          INITIAL_AGENT_MODE: "agent-full-access",
          NO_BROWSER: "1",
          ...(bins.codexBin ? { CODEX_PATH: bins.codexBin } : {}),
        },
        personaDelivery: "first_prompt",
        fullAccess: { kind: "env" },
        subagentTranscripts: false,
        modelFixedAtLaunch: false,
      };
    case "gemini":
      return {
        id: engine,
        bin: bins.geminiBin,
        args: [
          "--experimental-acp",
          ...(model !== "default" ? ["--model", model] : []),
        ],
        env: {},
        personaDelivery: "first_prompt",
        fullAccess: { kind: "set_mode", modeId: "yolo" },
        subagentTranscripts: false,
        modelFixedAtLaunch: true,
      };
    case "opencode":
      return {
        id: engine,
        bin: bins.opencodeBin,
        args: ["acp"],
        env: {},
        personaDelivery: "first_prompt",
        fullAccess: { kind: "permission_request" },
        subagentTranscripts: false,
        modelFixedAtLaunch: false,
      };
  }
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-agent-spec.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agents/harness/agent-spec.ts apps/server/test/harness-agent-spec.test.ts
git commit -m "feat(harness): engine table for claude, codex, gemini and opencode

One spec per engine: binary, arguments, environment, how full access is
granted, how the persona travels, and whether subagent transcripts are
negotiated. The engine is the first segment of the model id.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The driver spawns an engine spec

**Files:**

- Modify: `apps/server/src/agents/harness/driver.ts`
- Modify: `apps/server/test/helpers/fake-acp-agent.ts`
- Modify: `apps/server/test/harness-driver.test.ts`

**Interfaces:**

- Consumes: `EngineSpec` from `./agent-spec.js`.
- Produces:

```ts
export type DriverLaunch = {
  agentId: string; cwd: string;
  engine: EngineSpec;
  /** Persona for engines with personaDelivery "system_prompt"; null otherwise. */
  systemPromptAppend: string | null;
  mcp: { url: string; token: string };
  sessionId: string | null;
  env: NodeJS.ProcessEnv;
};
export class HarnessDriver {
  constructor(opts: { spawn?: SpawnFn; resolveBinary?: (bin: string, env: NodeJS.ProcessEnv) => Promise<string>; logger: DriverLogger });
  start(launch: DriverLaunch): Promise<{ sessionId: string; resumed: boolean }>;
  getConfigOptions(agentId: string): acp.SessionConfigOption[] | null;
  getCommands(agentId: string): acp.AvailableCommand[] | null;   // new
  setConfigOption(agentId, configId, value): Promise<acp.SessionConfigOption[]>;
  prompt / cancel / stop / onEvent / isRunning / liveAgentIds   // unchanged
}
// removed: probeConfigOptions, the dshBin/dshHome constructor options
```

- [ ] **Step 1: Extend the fake ACP agent**

In `apps/server/test/helpers/fake-acp-agent.ts`:

Change the options type and `seen`:

```ts
export function createFakeAcpAgent(
  opts: {
    turn?: FakeTurn;
    resumeFails?: boolean;
    /** Commands advertised right after a session opens. */
    commands?: acp.AvailableCommand[];
    /** Config options returned with the session. */
    configOptions?: acp.SessionConfigOption[];
  } = {}
) {
```

```ts
const seen = {
  initialize: [] as acp.InitializeRequest[],
  newSession: [] as acp.NewSessionRequest[],
  resumeSession: [] as acp.ResumeSessionRequest[],
  setMode: [] as acp.SetSessionModeRequest[],
  setConfig: [] as acp.SetSessionConfigOptionRequest[],
  prompts: [] as string[],
  cancels: 0,
  closes: 0,
};
```

Record `initialize`, advertise commands after a session opens, and add `setSessionMode` and `setSessionConfigOption`:

```ts
const announce = (sessionId: string) => {
  if (!opts.commands) return;
  setTimeout(() => {
    void connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: opts.commands ?? [],
      },
    });
  }, 0);
};

const agent: acp.Agent = {
  async initialize(params) {
    seen.initialize.push(params);
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "fake-acp-agent", version: "0.0.0" },
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
    seen.newSession.push(params);
    const sessionId = `sess_${++sessionCounter}`;
    announce(sessionId);
    return { sessionId, configOptions: opts.configOptions ?? [] };
  },
  async resumeSession(params) {
    seen.resumeSession.push(params);
    if (opts.resumeFails) throw new Error("unknown session");
    announce(params.sessionId);
    return { configOptions: opts.configOptions ?? [] };
  },
  async setSessionMode(params) {
    seen.setMode.push(params);
    return {};
  },
  async setSessionConfigOption(params) {
    seen.setConfig.push(params);
    const options = (opts.configOptions ?? []).map((o) =>
      o.id === params.configId ? { ...o, currentValue: params.value } : o
    );
    return { configOptions: options };
  },
  // prompt, cancel, closeSession unchanged
};
```

- [ ] **Step 2: Write the failing driver tests**

Replace the top of `apps/server/test/harness-driver.test.ts` (imports, `launch`, and the first test) with:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  engineSpecFor,
  type EngineBins,
} from "../src/agents/harness/agent-spec.js";
import {
  HarnessDriver,
  type DriverEvent,
  type DriverLaunch,
} from "../src/agents/harness/driver.js";
import { createFakeAcpAgent } from "./helpers/fake-acp-agent.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** The fake is spawned in-process, so skip the PATH lookup. */
const resolveBinary = async (bin: string) => bin;

const bins: EngineBins = {
  claudeHarnessBin: "/bin/claude-agent-acp",
  codexHarnessBin: "/bin/codex-acp",
  geminiBin: "/bin/gemini",
  opencodeBin: "/bin/opencode",
  claudeBin: "/home/u/.local/bin/claude",
  codexBin: null,
};

function launch(
  overrides: Partial<DriverLaunch> = {},
  engine: Parameters<typeof engineSpecFor>[0] = "claude",
  model = "default"
): DriverLaunch {
  return {
    agentId: "agt_1",
    cwd: "/tmp/w",
    engine: engineSpecFor(engine, model, bins),
    systemPromptAppend: engine === "claude" ? "Be brief." : null,
    mcp: { url: "http://127.0.0.1:1/api/mcp/agt_1", token: "tok" },
    sessionId: null,
    env: { PATH: "/usr/bin", HOME: "/home/u" },
    ...overrides,
  };
}

function driverWith(fake: ReturnType<typeof createFakeAcpAgent>) {
  const spawn = vi.fn(() => fake.child);
  return { spawn, driver: new HarnessDriver({ spawn, resolveBinary, logger }) };
}

describe("HarnessDriver", () => {
  it("claude: spawns the adapter with its args and env, declares subagent transcripts, sends the persona in _meta", async () => {
    const fake = createFakeAcpAgent();
    const { spawn, driver } = driverWith(fake);
    const { sessionId } = await driver.start(launch());
    expect(sessionId).toBe("sess_1");
    expect(spawn).toHaveBeenCalledWith(
      "/bin/claude-agent-acp",
      ["--dangerously-skip-permissions"],
      expect.objectContaining({
        cwd: "/tmp/w",
        env: expect.objectContaining({
          CLAUDE_CODE_EXECUTABLE: "/home/u/.local/bin/claude",
          HOME: "/home/u",
          PATH: "/usr/bin",
        }),
      })
    );
    expect(spawn.mock.calls[0][2].env).not.toHaveProperty("DSH_HOME");
    expect(fake.seen.initialize[0].clientCapabilities?._meta).toEqual({
      "subagent-transcript": true,
    });
    const req = fake.seen.newSession[0];
    expect(req.cwd).toBe("/tmp/w");
    expect(req._meta).toEqual({ systemPrompt: { append: "Be brief." } });
    expect(req.mcpServers).toEqual([
      {
        type: "http",
        name: "dispatch",
        url: "http://127.0.0.1:1/api/mcp/agt_1",
        headers: [{ name: "Authorization", value: "Bearer tok" }],
      },
    ]);
    expect(fake.seen.setMode).toEqual([]);
    await driver.stop("agt_1");
  });

  it("codex: no _meta persona, no subagent capability, full access by env", async () => {
    const fake = createFakeAcpAgent();
    const { spawn, driver } = driverWith(fake);
    await driver.start(launch({}, "codex", "gpt-5.6-sol"));
    expect(spawn).toHaveBeenCalledWith(
      "/bin/codex-acp",
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          INITIAL_AGENT_MODE: "agent-full-access",
          NO_BROWSER: "1",
        }),
      })
    );
    expect(fake.seen.initialize[0].clientCapabilities?._meta).toBeUndefined();
    expect(fake.seen.newSession[0]._meta).toBeUndefined();
    await driver.stop("agt_1");
  });

  it("gemini: sets the yolo mode right after the session opens, on new and on resume", async () => {
    const fake = createFakeAcpAgent();
    const { spawn, driver } = driverWith(fake);
    await driver.start(launch({}, "gemini", "gemini-2.5-pro"));
    expect(spawn.mock.calls[0][1]).toEqual([
      "--experimental-acp",
      "--model",
      "gemini-2.5-pro",
    ]);
    expect(fake.seen.setMode).toEqual([{ sessionId: "sess_1", modeId: "yolo" }]);
    await driver.stop("agt_1");
    const again = createFakeAcpAgent();
    const second = driverWith(again).driver;
    await second.start(launch({ sessionId: "sess_1" }, "gemini"));
    expect(again.seen.resumeSession).toHaveLength(1);
    expect(again.seen.setMode).toEqual([{ sessionId: "sess_1", modeId: "yolo" }]);
    await second.stop("agt_1");
  });

  it("keeps the commands the engine advertises", async () => {
    const fake = createFakeAcpAgent({
      commands: [
        { name: "review", description: "Review the branch", input: null },
        { name: "compact", description: "Compact", input: { hint: "focus" } },
      ],
    });
    const { driver } = driverWith(fake);
    await driver.start(launch({}, "opencode"));
    await new Promise((r) => setTimeout(r, 10));
    expect(driver.getCommands("agt_1")?.map((c) => c.name)).toEqual([
      "review",
      "compact",
    ]);
    expect(driver.getCommands("agt_nope")).toBeNull();
    await driver.stop("agt_1");
  });

  it("resumes over session/resume and sends the persona again for claude", async () => {
    const fake = createFakeAcpAgent();
    const { driver } = driverWith(fake);
    const { sessionId, resumed } = await driver.start(
      launch({ sessionId: "sess_prev" })
    );
    expect({ sessionId, resumed }).toEqual({ sessionId: "sess_prev", resumed: true });
    expect(fake.seen.newSession).toHaveLength(0);
    expect(fake.seen.resumeSession[0]).toMatchObject({
      sessionId: "sess_prev",
      cwd: "/tmp/w",
      _meta: { systemPrompt: { append: "Be brief." } },
    });
    await driver.stop("agt_1");
  });
```

Keep the remaining existing tests ("forwards updates and turn boundaries", "stop closes the session", "refuses to start twice", "a prompt rejected by the agent settles the turn with an error", and any others) but change each `new HarnessDriver({ dshBin: ..., dshHome: ..., spawn, resolveBinary, logger })` to `new HarnessDriver({ spawn: () => fake.child, resolveBinary, logger })` and each `launch()` call stays as is (it now returns a claude launch).

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-driver.test.ts`
Expected: FAIL: TypeScript errors on `dshBin` in the constructor and `overlayPath` in `DriverLaunch`.

- [ ] **Step 4: Rewrite the driver's launch path**

In `apps/server/src/agents/harness/driver.ts`:

Replace the header comment and `DriverLaunch`:

```ts
import type { EngineSpec } from "./agent-spec.js";

/**
 * The ACP client for the Dispatch Harness. One child per Dispatch agent,
 * spawned from the agent's engine spec; this module is the only place in
 * the server that speaks the protocol. Everything downstream consumes
 * {@link DriverEvent}s.
 */

export type DriverUpdate = acp.SessionUpdate;
export type DriverUsage = acp.Usage;

export type DriverLaunch = {
  agentId: string;
  cwd: string;
  /** What to spawn and how it takes persona, full access, and subagents. */
  engine: EngineSpec;
  /** The persona, for an engine whose spec says `system_prompt`; null otherwise. */
  systemPromptAppend: string | null;
  /** Dispatch's streamable HTTP MCP endpoint for this agent. */
  mcp: { url: string; token: string };
  /** Resume this ACP session when set; falls back to a new one if the engine lost it. */
  sessionId: string | null;
  env: NodeJS.ProcessEnv;
};
```

Add `commands` to `Live` and delete `PROBE_TIMEOUT_MS`:

```ts
type Live = {
  child: ChildProcessLike;
  conn: acp.ClientSideConnection;
  sessionId: string;
  stderrTail: string[];
  exited: Promise<ExitInfo>;
  /** Set at the top of stop(): the exit that follows is expected. */
  stopping: boolean;
  /** Session config options (model, reasoning effort) as the engine last reported. */
  config: { options: acp.SessionConfigOption[] };
  /** Slash commands as the engine last advertised them. */
  commands: acp.AvailableCommand[];
};
```

Reword `resolveExecutable`'s two errors and `describeExit`:

```ts
throw new Error(`${bin} is not executable at ${absolute}`);
// ...
throw new Error(
  `${bin} was not found on the server's PATH; set the engine's DISPATCH_*_BIN to an absolute path`
);
```

```ts
function describeExit(exit: ExitInfo): string {
  if (exit.error) {
    const code = (exit.error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? `the harness could not be spawned (${exit.error.message})`
      : exit.error.message;
  }
  return exit.code === null
    ? `the harness exited on signal ${exit.signal}`
    : `the harness exited with code ${exit.code}`;
}
```

Replace the class constructor and `start()` down to the `entry` assignment:

```ts
export class HarnessDriver {
  private readonly live = new Map<string, Live>();
  private readonly listeners = new Set<DriverListener>();
  private readonly spawnFn: SpawnFn;
  private readonly resolveBinary: (
    bin: string,
    env: NodeJS.ProcessEnv
  ) => Promise<string>;

  constructor(
    private readonly opts: {
      spawn?: SpawnFn;
      /** Injectable for tests that spawn a fake; defaults to a PATH lookup. */
      resolveBinary?: (bin: string, env: NodeJS.ProcessEnv) => Promise<string>;
      logger: DriverLogger;
    }
  ) {
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.resolveBinary = opts.resolveBinary ?? resolveExecutable;
  }

  onEvent(listener: DriverListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isRunning(agentId: string): boolean {
    return this.live.has(agentId);
  }

  liveAgentIds(): string[] {
    return [...this.live.keys()];
  }

  async start(
    launch: DriverLaunch
  ): Promise<{ sessionId: string; resumed: boolean }> {
    if (this.live.has(launch.agentId)) {
      throw new Error(`the harness is already running for ${launch.agentId}`);
    }
    const { engine } = launch;
    const env: NodeJS.ProcessEnv = { ...launch.env, ...engine.env };
    const bin = await this.resolveBinary(engine.bin, env);
    const child = this.spawnFn(bin, engine.args, { cwd: launch.cwd, env });
    // Both listeners go on before any await: a spawn failure (ENOENT, EACCES,
    // missing cwd) is an `error` event with no `exit`, and an unhandled one
    // would take the whole server down.
    const stderrTail: string[] = [];
    let settledExit: ExitInfo | null = null;
    const exited = new Promise<ExitInfo>((resolve) => {
      child.on("exit", (code, signal) =>
        resolve({ code, signal: signal ?? null })
      );
      child.on("error", (error: Error) =>
        resolve({ code: null, signal: null, error })
      );
    });
    void exited.then((exit) => {
      settledExit = exit;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    });

    const config = { options: [] as acp.SessionConfigOption[] };
    const commands: { list: acp.AvailableCommand[] } = { list: [] };
    const client: acp.Client = {
      sessionUpdate: async (params) => {
        if (params.update.sessionUpdate === "config_option_update") {
          config.options = params.update.configOptions ?? [];
        } else if (
          params.update.sessionUpdate === "available_commands_update"
        ) {
          commands.list = params.update.availableCommands ?? [];
        }
        this.emit({
          type: "update",
          agentId: launch.agentId,
          update: params.update,
        });
      },
      // An engine that asks per call (OpenCode) gets the allow option; the
      // others never ask under the full access their spec grants. With no
      // allow option, end the call cleanly rather than pick at random.
      requestPermission: async (params) => {
        const allow = params.options.find(
          (o) => o.kind === "allow_once" || o.kind === "allow_always"
        );
        if (!allow) {
          this.opts.logger.warn(
            {
              agentId: launch.agentId,
              options: params.options.map((o) => o.kind),
            },
            "permission request had no allow option; cancelling"
          );
          return { outcome: { outcome: "cancelled" } };
        }
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      },
    };
    if (!child.stdin || !child.stdout) {
      child.kill("SIGKILL");
      throw new Error("harness start failed: child has no stdio pipes");
    }
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout)
    );
    const conn = new acp.ClientSideConnection(() => client, stream);

    const sessionMeta = launch.systemPromptAppend
      ? { _meta: { systemPrompt: { append: launch.systemPromptAppend } } }
      : {};
    const handshake = (async () => {
      await conn.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          ...(engine.subagentTranscripts
            ? { _meta: { "subagent-transcript": true } }
            : {}),
        },
      });
      const mcpServers: acp.McpServer[] = [
        {
          type: "http",
          name: "dispatch",
          url: launch.mcp.url,
          headers: [
            { name: "Authorization", value: `Bearer ${launch.mcp.token}` },
          ],
        },
      ];
      let session: { sessionId: string; resumed: boolean } | null = null;
      if (launch.sessionId) {
        try {
          // session/resume, not session/load: load replays the history as
          // updates and the recorder would write every turn again.
          const resumed = await conn.resumeSession({
            sessionId: launch.sessionId,
            cwd: launch.cwd,
            mcpServers,
            ...sessionMeta,
          });
          config.options = resumed.configOptions ?? config.options;
          session = { sessionId: launch.sessionId, resumed: true };
        } catch (err) {
          // The engine no longer has the session (home cleared, store
          // pruned, or an earlier start died after the id was recorded). A
          // fresh session beats an agent that can never start again.
          this.opts.logger.warn(
            { err, agentId: launch.agentId, sessionId: launch.sessionId },
            "the engine could not resume the stored session; starting a new one"
          );
        }
      }
      if (!session) {
        const res = await conn.newSession({
          cwd: launch.cwd,
          mcpServers,
          ...sessionMeta,
        });
        config.options = res.configOptions ?? config.options;
        session = { sessionId: res.sessionId, resumed: false };
      }
      if (engine.fullAccess.kind === "set_mode") {
        try {
          await conn.setSessionMode({
            sessionId: session.sessionId,
            modeId: engine.fullAccess.modeId,
          });
        } catch (err) {
          this.opts.logger.warn(
            { err, agentId: launch.agentId, modeId: engine.fullAccess.modeId },
            "the engine refused the full-access mode; continuing with its default"
          );
        }
      }
      return session;
    })();
```

The `Outcome` race, the failure branch, and the `entry` construction stay as they are, with two edits: the timeout string becomes `` `the engine did not complete the ACP handshake within ${HANDSHAKE_TIMEOUT_MS / 1000}s` ``, the thrown error becomes `` `harness start failed: ${reason}${tail}` ``, and `entry` gains `commands: commands.list` with the `sessionUpdate` handler above writing into that same object (declare `const live: Live = {...}` after the race and have the handler read `commands.list`; simplest is to store the `commands` holder on the entry: `commands: commands.list` and, in the handler, `commands.list = ...` followed by `const entry = this.live.get(launch.agentId); if (entry) entry.commands = commands.list;`).

Replace `getConfigOptions` and delete `probeConfigOptions` entirely; add `getCommands`:

```ts
  /** The session's config options as last reported; null when not running. */
  getConfigOptions(agentId: string): acp.SessionConfigOption[] | null {
    return this.live.get(agentId)?.config.options ?? null;
  }

  /** The slash commands the engine advertised; null when not running. */
  getCommands(agentId: string): acp.AvailableCommand[] | null {
    return this.live.get(agentId)?.commands ?? null;
  }
```

In `prompt()`, `stop()`, `emit()`, `require()` replace every "dsh" in a string with "the harness" (`"the harness exited before the turn settled"`, `"harness session close failed; continuing teardown"`, `"harness driver listener threw"`, `` `the harness is not running for ${agentId}` ``), and the info log `"dsh session ready"` becomes `"harness session ready"`.

- [ ] **Step 5: Run the driver tests to see them pass**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-driver.test.ts`
Expected: PASS. If `_meta` on `clientCapabilities` fails the SDK's type check, the SDK 1.4.0 `ClientCapabilities` type does carry `_meta?: { [key: string]: unknown } | null` (verified in `dist/schema/types.gen.d.ts`); check the spread is inside `clientCapabilities`, not beside it.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agents/harness/driver.ts apps/server/test/helpers/fake-acp-agent.ts apps/server/test/harness-driver.test.ts
git commit -m "feat(harness): drive any engine spec over ACP

The driver spawns whatever the spec names, declares subagent transcripts
only when the spec asks, sends the persona in _meta.systemPrompt for
engines that take it there, sets the full-access mode for engines that
expose one, and keeps the advertised slash commands. The dsh probe
session is gone.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The recorder learns plans, usage, and nested calls

**Files:**

- Modify: `apps/server/src/agents/harness/stream-store.ts:4-53`
- Modify: `apps/server/src/agents/harness/stream-recorder.ts`
- Test: `apps/server/test/harness-stream-recorder.test.ts`

**Interfaces:**

- Produces:

```ts
export type StreamEventKind =
  | "assistant"
  | "thought"
  | "tool_call"
  | "status"
  | "turn"
  | "plan";
export type PlanPayload = {
  entries: { content: string; status: string; priority: string }[];
};
export type ToolPayload = { /* existing */ parentToolCallId?: string };
export type TurnPayload = {
  /* existing */ usage?: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string };
  };
};
// StreamRecorder constructor deps lose `commandLog`.
```

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/test/harness-stream-recorder.test.ts` inside `describe("StreamRecorder", ...)`:

```ts
it("writes a plan row for the live turn and replaces it on the next plan", async () => {
  const rec = new StreamRecorder(store);
  await rec.handle({ type: "turn", agentId: A, state: "started", text: "x" });
  await rec.handle({
    type: "update",
    agentId: A,
    update: {
      sessionUpdate: "plan",
      entries: [
        { content: "read", status: "completed", priority: "high" },
        { content: "edit", status: "in_progress", priority: "medium" },
      ],
    },
  });
  await rec.handle({
    type: "update",
    agentId: A,
    update: {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "p1",
        entries: [
          { content: "read", status: "completed", priority: "high" },
          { content: "edit", status: "completed", priority: "medium" },
        ],
      },
    },
  });
  const plans = (await store.list(A, 10)).filter((r) => r.kind === "plan");
  expect(plans).toHaveLength(1);
  expect(plans[0].payload).toEqual({
    entries: [
      { content: "read", status: "completed", priority: "high" },
      { content: "edit", status: "completed", priority: "medium" },
    ],
  });
});

it("ignores a plan_update that is a file or markdown plan", async () => {
  const rec = new StreamRecorder(store);
  await rec.handle({ type: "turn", agentId: A, state: "started", text: "x" });
  await rec.handle({
    type: "update",
    agentId: A,
    update: {
      sessionUpdate: "plan_update",
      plan: { type: "markdown", planId: "p2", content: "# steps" } as never,
    },
  });
  expect((await store.list(A, 10)).filter((r) => r.kind === "plan")).toEqual(
    []
  );
});

it("stores usage on the live turn row", async () => {
  const rec = new StreamRecorder(store);
  await rec.handle({ type: "turn", agentId: A, state: "started", text: "x" });
  await rec.handle({
    type: "update",
    agentId: A,
    update: {
      sessionUpdate: "usage_update",
      used: 12_000,
      size: 200_000,
      cost: { amount: 0.42, currency: "USD" },
    },
  });
  const turn = (await store.list(A, 10)).find((r) => r.kind === "turn");
  expect(turn?.payload).toMatchObject({
    usage: {
      used: 12_000,
      size: 200_000,
      cost: { amount: 0.42, currency: "USD" },
    },
  });
  await rec.handle({
    type: "update",
    agentId: A,
    update: { sessionUpdate: "usage_update", used: 13_000, size: 200_000 },
  });
  const again = (await store.list(A, 10)).find((r) => r.kind === "turn");
  expect(again?.payload).toMatchObject({
    usage: { used: 13_000, size: 200_000 },
  });
  expect(
    (again?.payload as { usage: Record<string, unknown> }).usage
  ).not.toHaveProperty("cost");
});

it("keeps the parent tool call id a nested call carries", async () => {
  const rec = new StreamRecorder(store);
  await rec.handle({
    type: "update",
    agentId: A,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "task_1",
      title: "Task",
      kind: "other",
      status: "in_progress",
    },
  });
  await rec.handle({
    type: "update",
    agentId: A,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "child_1",
      title: "Read",
      kind: "read",
      status: "pending",
      _meta: { claudeCode: { toolName: "Read", parentToolUseId: "task_1" } },
    },
  });
  await rec.handle({
    type: "update",
    agentId: A,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "child_1",
      status: "completed",
    },
  });
  const child = await store.getByKey(A, "tool_call", "child_1");
  expect(child?.payload).toMatchObject({
    parentToolCallId: "task_1",
    status: "completed",
  });
  const parent = await store.getByKey(A, "tool_call", "task_1");
  expect(parent?.payload).not.toHaveProperty("parentToolCallId");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-stream-recorder.test.ts`
Expected: FAIL on the four new tests (no `plan` rows, no `usage`, no `parentToolCallId`); the existing tests pass.

- [ ] **Step 3: Extend the store's types**

In `apps/server/src/agents/harness/stream-store.ts`:

```ts
export type StreamEventKind =
  | "assistant"
  | "thought"
  | "tool_call"
  | "status"
  | "turn"
  | "plan";
```

Add `parentToolCallId` to `ToolPayload`, after `input?: unknown;`:

```ts
  /** A nested call: the toolCallId of the step it runs under (a subagent's parent). */
  parentToolCallId?: string;
```

Add `PlanPayload` after `StatusPayload`, and `usage` to `TurnPayload` after `endedAt?: string;`:

```ts
/** The task list as the engine last published it; one row per turn, rewritten in place. */
export type PlanPayload = {
  entries: { content: string; status: string; priority: string }[];
};
```

```ts
  /** The engine's last usage_update in this turn: context used and, when reported, cost so far. */
  usage?: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string };
  };
```

Add `plan: PlanPayload;` to `StreamPayloadByKind`. Update the class comment: "Append-only except for tool calls and plans, which are rewritten in place under their key."

- [ ] **Step 4: Teach the recorder**

In `apps/server/src/agents/harness/stream-recorder.ts`:

Remove the `CommandLogEntry` import and the `commandLog` dep from the constructor's `deps` type. Import `PlanPayload`:

```ts
import type {
  PlanPayload,
  StreamEventRow,
  StreamStore,
  ToolPayload,
  TurnPayload,
} from "./stream-store.js";
```

Add a helper next to `commandOf`:

```ts
/** The parent tool call a nested call names (Claude stamps `_meta.claudeCode.parentToolUseId`). */
function parentToolCallIdOf(meta: unknown): string | null {
  if (typeof meta !== "object" || meta === null) return null;
  const claude = (meta as { claudeCode?: unknown }).claudeCode;
  if (typeof claude !== "object" || claude === null) return null;
  const parent = (claude as { parentToolUseId?: unknown }).parentToolUseId;
  return typeof parent === "string" && parent ? parent : null;
}
```

In `handleUpdate`, in the `tool_call` case, add the parent to the payload:

```ts
const parentToolCallId = parentToolCallIdOf(update._meta);
const payload: ToolPayload = {
  toolKind: inferToolKind(update.kind, update.title),
  title: update.title,
  status: update.status ?? "pending",
  locations: this.projectLocations(agentId, update.locations),
  diff,
  terminalOutput,
  ...(truncated ? { truncated: true } : {}),
  ...(input !== undefined ? { input } : {}),
  ...(parentToolCallId ? { parentToolCallId } : {}),
};
```

In the `tool_call_update` case, carry the parent forward and drop the command-log block:

```ts
const next: ToolPayload = {
  toolKind: inferToolKind(update.kind ?? prev.toolKind, title),
  title,
  status: update.status ?? prev.status ?? "pending",
  locations: update.locations
    ? this.projectLocations(agentId, update.locations)
    : (prev.locations ?? []),
  diff: projected?.diff ?? prev.diff ?? null,
  terminalOutput: projected?.terminalOutput ?? prev.terminalOutput ?? null,
  ...(truncated ? { truncated: true } : {}),
  ...(update.rawInput !== undefined
    ? { input: boundInput(update.rawInput) }
    : prev.input !== undefined
      ? { input: prev.input }
      : {}),
  ...(prev.parentToolCallId ? { parentToolCallId: prev.parentToolCallId } : {}),
};
await this.store.updatePayload(existing.id, next);
return;
```

Add three cases before `default:`:

```ts
      case "plan":
        return this.writePlan(agentId, update.entries);
      case "plan_update":
        // Only an item list is a task list; a file or markdown plan is prose.
        if (update.plan.type !== "items") return;
        return this.writePlan(agentId, update.plan.entries);
      case "plan_removed":
        return this.writePlan(agentId, []);
      case "usage_update":
        return this.writeUsage(agentId, update);
```

Add the two methods after `handleUpdate`:

```ts
  /** One plan row per turn, keyed by the turn row, rewritten as the list changes. */
  private async writePlan(
    agentId: string,
    entries: readonly {
      content: string;
      status: string;
      priority: string;
    }[]
  ): Promise<void> {
    const open = this.openTurn.get(agentId);
    const key = open ? `plan:${open.id}` : "plan:pre";
    const payload: PlanPayload = {
      entries: entries.map((e) => ({
        content: e.content,
        status: e.status,
        priority: e.priority,
      })),
    };
    await this.store.upsertByKey(agentId, "plan", key, payload);
  }

  /** The live turn carries the engine's newest usage; nothing else stores it. */
  private async writeUsage(
    agentId: string,
    update: { used: number; size: number; cost?: { amount: number; currency: string } | null }
  ): Promise<void> {
    const open = this.openTurn.get(agentId);
    if (!open) return;
    const prev = open.payload as TurnPayload;
    const next: TurnPayload = {
      ...prev,
      usage: {
        used: update.used,
        size: update.size,
        ...(update.cost
          ? { cost: { amount: update.cost.amount, currency: update.cost.currency } }
          : {}),
      },
    };
    open.payload = next as unknown as Record<string, unknown>;
    await this.store.updatePayload(open.id, next);
  }
```

`openAutonomousIfNeeded` must not open a turn for a `plan` or `usage_update` (it already returns for anything but text and `tool_call`). Every "dsh" in a comment or string in this file becomes "the engine" or "the harness" (`"the harness exited before the turn settled"`, `` `the harness exited with ${how}${detail}` ``); `GOAL_ROUND_PROMPT` keeps its text.

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-stream-recorder.test.ts`
Expected: PASS, all tests including the four new ones.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agents/harness/stream-store.ts apps/server/src/agents/harness/stream-recorder.ts apps/server/test/harness-stream-recorder.test.ts
git commit -m "feat(harness): record plans, usage and nested tool calls

plan and plan_update (item lists) rewrite one plan row per turn;
usage_update lands on the live turn row; a tool call stamped with a
parent tool use id keeps it as parentToolCallId. The dsh command log
hook is gone.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Turns nest child steps and carry plan and usage

**Files:**

- Modify: `apps/server/src/agents/harness/turns.ts`
- Test: `apps/server/test/harness-turns.test.ts`

**Interfaces:**

- Consumes: `HarnessPlanEntry`, `HarnessStep.children`, `HarnessTurn.plan`, `HarnessTurn.usage` (Task 3); `PlanPayload`, `ToolPayload.parentToolCallId`, `TurnPayload.usage` (Task 6).
- Produces: `TurnSourceRow` gains `key: string | null`; `assembleTurns` nests steps whose `parentToolCallId` names another step in the same turn, sets `turn.plan` from the group's newest `plan` row, and `turn.usage` from the turn payload.

- [ ] **Step 1: Write the failing tests**

In `apps/server/test/harness-turns.test.ts`, extend the `row` helper to take a key:

```ts
function row(
  kind: TurnSourceRow["kind"],
  payload: Record<string, unknown>,
  s: number,
  settledAt?: number,
  key: string | null = null
): TurnSourceRow {
  seq += 1;
  return {
    id: seq,
    seq,
    kind,
    key,
    payload,
    createdAt: at(s),
    updatedAt: at(settledAt ?? s),
  };
}
```

Add inside `describe("assembleTurns", ...)`:

```ts
it("nests a subagent's steps under the parent Task step", () => {
  seq = 0;
  const rows = [
    row(
      "turn",
      {
        state: "settled",
        prompt: { source: "system", text: "go" },
        stopReason: "end_turn",
        endedAt: at(9).toISOString(),
      },
      0,
      9
    ),
    row(
      "tool_call",
      {
        toolKind: "other",
        title: "Task",
        status: "completed",
        locations: [],
        diff: null,
        terminalOutput: null,
      },
      1,
      8,
      "task_1"
    ),
    row(
      "tool_call",
      {
        toolKind: "read",
        title: "Read",
        status: "completed",
        locations: [{ path: "a.ts" }],
        diff: null,
        terminalOutput: null,
        parentToolCallId: "task_1",
      },
      2,
      3,
      "child_1"
    ),
    row(
      "tool_call",
      {
        toolKind: "execute",
        title: "bash",
        status: "completed",
        locations: [],
        diff: null,
        terminalOutput: "ok",
        parentToolCallId: "task_1",
      },
      4,
      5,
      "child_2"
    ),
    row(
      "tool_call",
      {
        toolKind: "edit",
        title: "Edit",
        status: "completed",
        locations: [],
        diff: null,
        terminalOutput: null,
      },
      6,
      7,
      "top_2"
    ),
  ];
  const [turn] = assembleTurns(rows, new Map());
  expect(turn.trace.steps.map((s) => s.label)).toEqual(["Task", "Edit"]);
  expect(turn.trace.steps[0].children?.map((s) => s.label)).toEqual([
    "Read",
    "bash",
  ]);
  expect(turn.trace.steps[0].children?.[0].detail.parentToolCallId).toBe(
    "task_1"
  );
  expect(turn.trace.steps[1].children).toBeUndefined();
});

it("keeps a child whose parent is not in the turn at the top level", () => {
  seq = 0;
  const rows = [
    row(
      "turn",
      {
        state: "settled",
        prompt: { source: "system", text: "go" },
        stopReason: "end_turn",
        endedAt: at(2).toISOString(),
      },
      0,
      2
    ),
    row(
      "tool_call",
      {
        toolKind: "read",
        title: "Read",
        status: "completed",
        locations: [],
        diff: null,
        terminalOutput: null,
        parentToolCallId: "gone",
      },
      1,
      1,
      "orphan"
    ),
  ];
  const [turn] = assembleTurns(rows, new Map());
  expect(turn.trace.steps.map((s) => s.label)).toEqual(["Read"]);
});

it("carries the newest plan and the turn's usage", () => {
  seq = 0;
  const rows = [
    row(
      "turn",
      {
        state: "settled",
        prompt: { source: "system", text: "go" },
        stopReason: "end_turn",
        endedAt: at(5).toISOString(),
        usage: {
          used: 4200,
          size: 200000,
          cost: { amount: 0.5, currency: "USD" },
        },
      },
      0,
      5
    ),
    row(
      "plan",
      {
        entries: [
          { content: "a", status: "completed", priority: "high" },
          { content: "b", status: "in_progress", priority: "low" },
        ],
      },
      1,
      4,
      "plan:1"
    ),
    row("assistant", { text: "done", streaming: false }, 2),
  ];
  const [turn] = assembleTurns(rows, new Map());
  expect(turn.plan).toEqual([
    { content: "a", status: "completed", priority: "high" },
    { content: "b", status: "in_progress", priority: "low" },
  ]);
  expect(turn.usage).toEqual({ used: 4200, size: 200000, costUsd: 0.5 });
  expect(turn.trace.steps).toEqual([]);
});

it("reports usage without cost as costUsd null", () => {
  seq = 0;
  const rows = [
    row(
      "turn",
      {
        state: "settled",
        prompt: { source: "system", text: "go" },
        stopReason: "end_turn",
        endedAt: at(1).toISOString(),
        usage: { used: 10, size: 100 },
      },
      0,
      1
    ),
  ];
  const [turn] = assembleTurns(rows, new Map());
  expect(turn.usage).toEqual({ used: 10, size: 100, costUsd: null });
});
```

Every existing `row(...)` call in the file compiles unchanged (the new parameter is optional). Remove any test that asserts `subagentSessionId` on a step.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-turns.test.ts`
Expected: FAIL on the four new tests (`key` is not on `TurnSourceRow`; no nesting; `plan` and `usage` undefined).

- [ ] **Step 3: Rewrite the assembler**

In `apps/server/src/agents/harness/turns.ts`:

Imports: drop `import { subagentIdFromOutput } from "./subagents.js";`, add `HarnessPlanEntry` to the `@dispatch/shared` import and `PlanPayload` to the store import:

```ts
import type {
  ChatMessage,
  HarnessPlanEntry,
  HarnessPrompt,
  HarnessQueuedPrompt,
  HarnessQuestion,
  HarnessStep,
  HarnessTurn,
} from "@dispatch/shared";

import { type Queryable, toChatMessage } from "../../chat/store.js";
import type { PromptSource } from "./prompt-source.js";
import type {
  AssistantPayload,
  PlanPayload,
  StreamEventRow,
  ThoughtPayload,
  ToolPayload,
  TurnPayload,
} from "./stream-store.js";

export type TurnSourceRow = Pick<
  StreamEventRow,
  "id" | "seq" | "kind" | "key" | "payload" | "createdAt" | "updatedAt"
>;
```

Replace `toolStep` so it no longer parses subagent output and carries the parent id:

```ts
function toolStep(row: TurnSourceRow): HarnessStep | null {
  const p = row.payload as Partial<ToolPayload>;
  const title = p.title ?? "";
  if (DROPPED_TOOL_TITLES.has(title)) return null;
  const settled = p.status === "completed" || p.status === "failed";
  return {
    id: `stream:${row.id}`,
    kind: p.toolKind ?? "other",
    label: title,
    status:
      p.status === "completed"
        ? "ok"
        : p.status === "failed"
          ? "error"
          : "running",
    startedAt: row.createdAt.toISOString(),
    ...(settled
      ? {
          endedAt: row.updatedAt.toISOString(),
          durMs: Math.max(0, row.updatedAt.getTime() - row.createdAt.getTime()),
        }
      : {}),
    detail: {
      toolKind: p.toolKind,
      locations: p.locations?.length
        ? p.locations
        : locationsFromInput(p.input, p.terminalOutput),
      diff: p.diff ?? null,
      terminalOutput: p.terminalOutput ?? null,
      ...(p.truncated ? { truncated: true } : {}),
      ...(p.input !== undefined ? { input: p.input } : {}),
      ...(p.parentToolCallId ? { parentToolCallId: p.parentToolCallId } : {}),
    },
  };
}
```

Add two helpers after `toQuestion`:

```ts
/**
 * Hang each step that names a parent under that parent, in stream order.
 * A parent outside the turn (or dropped as a status event) leaves the child
 * at the top level rather than losing it.
 */
function nestSteps(
  flat: { step: HarnessStep; key: string | null; parent: string | null }[]
): HarnessStep[] {
  const byKey = new Map<string, HarnessStep>();
  for (const { step, key } of flat) if (key) byKey.set(key, step);
  const top: HarnessStep[] = [];
  for (const { step, parent } of flat) {
    const owner = parent ? byKey.get(parent) : undefined;
    if (owner && owner !== step) (owner.children ??= []).push(step);
    else top.push(step);
  }
  return top;
}

function planEntriesOf(row: TurnSourceRow): HarnessPlanEntry[] {
  const p = row.payload as Partial<PlanPayload>;
  return (p.entries ?? []).map((e) => ({
    content: e.content,
    status: e.status as HarnessPlanEntry["status"],
    priority: e.priority as HarnessPlanEntry["priority"],
  }));
}
```

In `assembleTurns`, replace the step-building loop and the return so steps are collected flat and nested afterwards, and the plan and usage are read:

```ts
const flat: { step: HarnessStep; key: string | null; parent: string | null }[] =
  [];
let plan: HarnessPlanEntry[] | undefined;
let label: string | undefined;
let labelTerminal = false;
for (const row of group.rows) {
  if (row.kind === "tool_call") {
    const status = statusEventOf(row);
    if (status) {
      const terminal = status.type !== "working";
      if (terminal || !labelTerminal) {
        label = status.message;
        labelTerminal = terminal;
      }
    }
    const step = toolStep(row);
    if (step) {
      flat.push({
        step,
        key: row.key,
        parent: (row.payload as Partial<ToolPayload>).parentToolCallId ?? null,
      });
    }
  } else if (row.kind === "thought") {
    flat.push({
      step: noteStep(row, "think", live && row === newest),
      key: null,
      parent: null,
    });
  } else if (row.kind === "assistant") {
    if (row === last) {
      const p = row.payload as Partial<AssistantPayload>;
      result = {
        text: p.text ?? "",
        streaming: p.streaming === true && !settled,
        ...(p.truncated ? { truncated: true } : {}),
      };
    } else {
      flat.push({ step: noteStep(row, "note"), key: null, parent: null });
    }
  } else if (row.kind === "plan") {
    plan = planEntriesOf(row);
  }
}
const steps = nestSteps(flat);
const error = turnPayload?.error;
const lastRow = group.rows[group.rows.length - 1];
const trace: HarnessTurn["trace"] = { startedAt, steps };
if (settled) {
  if (turnPayload?.endedAt) trace.endedAt = turnPayload.endedAt;
  trace.finalResult = error
    ? "error"
    : turnPayload?.stopReason === "cancelled"
      ? "interrupted"
      : "ok";
} else if (!group.turn && lastRow) {
  trace.endedAt = lastRow.updatedAt.toISOString();
  trace.finalResult = "ok";
}
const usage = turnPayload?.usage
  ? {
      used: turnPayload.usage.used,
      size: turnPayload.usage.size,
      costUsd:
        turnPayload.usage.cost && turnPayload.usage.cost.currency === "USD"
          ? turnPayload.usage.cost.amount
          : null,
    }
  : undefined;
return {
  id: group.turn ? `turn:${group.turn.id}` : `turn:pre:${index}`,
  prompt: turnPayload
    ? promptFor(turnPayload.prompt, chat)
    : { source: "system", text: "Earlier activity", attachments: [] },
  trace,
  result,
  ...(turnQuestions ? { questions: turnQuestions } : {}),
  ...(label ? { label } : {}),
  ...(error ? { error } : {}),
  ...(plan ? { plan } : {}),
  ...(usage ? { usage } : {}),
};
```

Delete the old `const steps: HarnessStep[] = [];` line and the old `let label`/`let labelTerminal` declarations above the loop (they are re-declared in the block above). In `loadTurns`, add `key` to the SELECT and the row mapping:

```ts
const rows = await db.query<{
  id: number | string;
  seq: number;
  kind: StreamEventRow["kind"];
  key: string | null;
  payload: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}>(
  `SELECT id, seq, kind, key, payload, created_at, updated_at
       FROM agent_stream_events
      WHERE agent_id = $1 AND seq >= $2
      ORDER BY seq ASC`,
  [agentId, fromSeq]
);
const source: TurnSourceRow[] = rows.rows.map((r) => ({
  id: Number(r.id),
  seq: r.seq,
  kind: r.kind,
  key: r.key,
  payload: r.payload,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
}));
```

Delete the `READ_PATH_TAG` comment's "dsh" wording ("The read tool may wrap its result as ...").

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-turns.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agents/harness/turns.ts apps/server/test/harness-turns.test.ts
git commit -m "feat(harness): nest subagent steps and carry plan and usage on turns

A step that names a parent tool call hangs under it; the newest plan row
in the turn becomes turn.plan and the turn payload's usage becomes
turn.usage with cost in USD when the engine reported one. The zstd
session-log path for subagents is no longer read.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The supervisor picks the engine and delivers the persona

**Files:**

- Modify: `apps/server/src/agents/harness/supervisor.ts`
- Test: `apps/server/test/harness-supervisor.test.ts`

**Interfaces:**

- Consumes: `engineSpecFor`, `splitModelId`, `EngineBins` (Task 4); `HarnessDriver`, `resolveExecutable`, `DriverLaunch` (Task 5); `DEFAULT_HARNESS_MODEL`, `HarnessCommand` (Task 3).
- Produces:

```ts
export type SupervisorDeps = {
  pool: Pool;
  config: Pick<
    AppConfig,
    | "claudeHarnessBin"
    | "codexHarnessBin"
    | "geminiBin"
    | "opencodeBin"
    | "claudeBin"
    | "codexBin"
    | "port"
    | "tls"
    | "authToken"
    | "mediaRoot"
  >;
  logger: DriverLogger;
  driver?: HarnessDriver;
  /** Bins are resolved through this before spawning; injectable for tests. */
  resolveBinary?: (bin: string, env: NodeJS.ProcessEnv) => Promise<string>;
  // getAgent, setCliSessionId, setLatestEvent, publishHarness, personaPromptFor,
  // activeJobRunIdFor, launchPromptFor, listRunningAgentIds, markStartFailed,
  // setAgentModel, markExited: unchanged
};
export class HarnessSupervisor {
  getCommands(agentId: string): HarnessCommand[] | null; // new
  getConfigOptions(agentId: string): HarnessConfigOption[] | null; // no provider filtering
  // modelCatalog() removed; everything else keeps its signature
}
```

- [ ] **Step 1: Write the failing tests**

Replace the `build()` helper's `driver`, `config`, and `getAgent` pieces in `apps/server/test/harness-supervisor.test.ts` so the fake is engine-aware, and delete the `defaultModelFor` tests:

```ts
import { createJobMcpToken } from "../src/auth.js";
import { HarnessDriver } from "../src/agents/harness/driver.js";
import {
  buildChildEnv,
  HarnessSupervisor,
  RESTART_PROMPT,
} from "../src/agents/harness/supervisor.js";
import { createFakeAcpAgent, type FakeTurn } from "./helpers/fake-acp-agent.js";
```

```ts
async function build(
  opts: {
    turn?: FakeTurn;
    cliSessionId?: string;
    launchPrompt?: string;
    /** The agent's stored model id; claude/default when omitted. */
    model?: string | null;
    /** Config options the fake session publishes. */
    configOptions?: Parameters<typeof createFakeAcpAgent>[0]["configOptions"];
    startFails?: boolean;
    lastTurnError?: string | null;
    lastTurnEndedAt?: Date;
    resumeFails?: boolean;
  } = {}
) {
  home = await mkdtemp(path.join(os.tmpdir(), "harness-sup-"));
  const fake = createFakeAcpAgent({
    turn: opts.turn,
    resumeFails: opts.resumeFails,
    configOptions: opts.configOptions,
  });
  const resolveBinary = async (bin: string) => {
    if (opts.startFails) throw new Error(`${bin} was not found on the server's PATH`);
    return bin;
  };
  const driver = new HarnessDriver({
    spawn: () => fake.child,
    resolveBinary,
    logger,
  });
```

```ts
  const deps = {
    pool: { query } as never,
    config: {
      claudeHarnessBin: "/bin/claude-agent-acp",
      codexHarnessBin: "/bin/codex-acp",
      geminiBin: "/bin/gemini",
      opencodeBin: "/bin/opencode",
      claudeBin: "/bin/claude",
      codexBin: "/bin/codex",
      port: 1,
      tls: null,
      authToken: "secret",
      mediaRoot: path.join(home, "media"),
    },
    logger,
    driver,
    resolveBinary,
    getAgent: vi.fn(async (id: string) => ({
      id,
      type: "dispatch",
      cwd: "/tmp/w",
      mediaDir: null,
      model: opts.model === undefined ? null : opts.model,
      cliSessionId: opts.cliSessionId ?? null,
      // ...the rest of the existing stub fields unchanged
```

Keep the rest of `build()` (the `events` capture, `personaPromptFor: async () => "PERSONA TEXT"`, `launchPromptFor`, etc.) as it is, and return `fake` alongside the supervisor. Then add these tests:

```ts
describe("HarnessSupervisor engines", () => {
  it("claude: persona travels in _meta and the first prompt is the launch post alone", async () => {
    const { sup, fake } = await build({
      launchPrompt:
        "--- DISPATCH CHAT (id: 11111111-1111-1111-1111-111111111111) ---\nhello",
    });
    await sup.start("agt_c");
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.seen.newSession[0]._meta).toEqual({
      systemPrompt: { append: "PERSONA TEXT" },
    });
    expect(fake.seen.prompts[0]).toMatch(/^--- DISPATCH CHAT/);
    await sup.stop("agt_c");
  });

  it("codex: the persona is the leading block of the first prompt of a fresh session", async () => {
    const { sup, fake } = await build({
      model: "codex/default",
      launchPrompt:
        "--- DISPATCH CHAT (id: 22222222-2222-2222-2222-222222222222) ---\nhello",
    });
    await sup.start("agt_x");
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.seen.newSession[0]._meta).toBeUndefined();
    expect(fake.seen.prompts[0]).toBe(
      "PERSONA TEXT\n\n--- DISPATCH CHAT (id: 22222222-2222-2222-2222-222222222222) ---\nhello"
    );
    // The second prompt carries no persona.
    await sup.prompt("agt_x", "again");
    expect(fake.seen.prompts[1]).toBe("again");
    await sup.stop("agt_x");
  });

  it("codex: a resumed session gets no persona prefix", async () => {
    const { sup, fake } = await build({
      model: "codex/default",
      cliSessionId: "sess_old",
    });
    await sup.start("agt_r");
    await sup.prompt("agt_r", "continue");
    expect(fake.seen.prompts).toEqual(["continue"]);
    await sup.stop("agt_r");
  });

  it("gemini: sets the yolo mode and never asks the session for a model option", async () => {
    const { sup, fake } = await build({ model: "gemini/gemini-2.5-pro" });
    await sup.start("agt_g");
    expect(fake.seen.setMode).toEqual([
      { sessionId: "sess_1", modeId: "yolo" },
    ]);
    expect(fake.seen.setConfig).toEqual([]);
    await sup.stop("agt_g");
  });

  it("applies a non-default model through the session's model option", async () => {
    const { sup, fake } = await build({
      model: "opencode/anthropic/claude-sonnet-5",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "openai/gpt-5.5",
          options: [
            { value: "openai/gpt-5.5", name: "GPT-5.5" },
            { value: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
          ],
        },
      ],
    });
    await sup.start("agt_o");
    expect(fake.seen.setConfig).toEqual([
      {
        sessionId: "sess_1",
        configId: "model",
        value: "anthropic/claude-sonnet-5",
      },
    ]);
    await sup.stop("agt_o");
  });

  it("warns and keeps the default when a non-default model meets no model option", async () => {
    const { sup, fake } = await build({ model: "codex/gpt-5.6-sol" });
    await sup.start("agt_w");
    expect(fake.seen.setConfig).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agt_w", model: "gpt-5.6-sol" }),
      expect.stringMatching(/publishes no model option/)
    );
    await sup.stop("agt_w");
  });

  it("rejects an agent whose model has no engine prefix", async () => {
    const { sup } = await build({ model: "gpt-5.6-sol" });
    await expect(sup.start("agt_bad")).rejects.toThrow(/engine\/model/);
  });

  it("serves the commands the engine advertised", async () => {
    const { sup } = await build();
    expect(sup.getCommands("agt_none")).toBeNull();
  });
});
```

Update every existing assertion in the file that reads `"dsh session started."` / `"dsh session resumed."` to `"Harness session started."` / `"Harness session resumed."`, and any `/dsh exited/` to `/the engine exited/`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-supervisor.test.ts`
Expected: FAIL: TypeScript errors on `config` (no `claudeHarnessBin`), `resolveBinary` not a dep, and the removed exports.

- [ ] **Step 3: Rewrite the supervisor's engine path**

In `apps/server/src/agents/harness/supervisor.ts`:

Imports become:

```ts
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  DEFAULT_HARNESS_MODEL,
  type AgentLatestEventType,
  type AgentRecord,
  type HarnessCommand,
  type HarnessConfigOption,
} from "@dispatch/shared";

import { createAgentMcpToken, createJobMcpToken } from "../../auth.js";
import type { AppConfig } from "../../config.js";
import { resolveMediaDir } from "../../shared/media.js";
import { dispatchMcpUrl } from "../tmux/mcp-url.js";
import {
  engineSpecFor,
  splitModelId,
  type EngineBins,
  type HarnessEngineId,
} from "./agent-spec.js";
import {
  HarnessDriver,
  resolveExecutable,
  type DriverEvent,
  type DriverLogger,
} from "./driver.js";
import { parsePromptSource, type QueuedPrompt } from "./prompt-source.js";
import { StreamRecorder } from "./stream-recorder.js";
import { StreamStore } from "./stream-store.js";
import { UsageRecorder } from "./usage-recorder.js";
```

`SupervisorDeps.config` and the new dep:

```ts
  config: Pick<
    AppConfig,
    | "claudeHarnessBin"
    | "codexHarnessBin"
    | "geminiBin"
    | "opencodeBin"
    | "claudeBin"
    | "codexBin"
    | "port"
    | "tls"
    | "authToken"
    | "mediaRoot"
  >;
  logger: DriverLogger;
  /** Injectable for tests; defaults to a driver that spawns the real binaries. */
  driver?: HarnessDriver;
  /** How engine binaries are found before spawning; defaults to a PATH lookup. */
  resolveBinary?: (bin: string, env: NodeJS.ProcessEnv) => Promise<string>;
```

Reword the deps comments that say dsh: `personaPromptFor` "Full persona text (see persona.ts)", `launchPromptFor` "The harness takes no launch argument, so the supervisor sends it as the first turn", `listRunningAgentIds` "Harness agents recorded as running".

Delete everything from `/** dsh route ids that name a provider ... */` through `defaultModelFor` and `GRANTS_TTL_MS` (the `ROUTE_ALIASES`, `PROVIDER_KEY_ENV`, `PROVIDER_GRANT`, `NO_GRANTS`, `routeAuthenticated`, `SelectOption`, `SelectGroup`, `CATALOG_MODEL_ALLOW`, `modelNameOf`, `groupIdOf`, `isGroup`, `filterConfigOptionsByKeys`, `catalogFromConfigOptions`, `modelIdFromValue`, `CATALOG_TTL_MS`, `defaultModelFor`, `GRANTS_TTL_MS` blocks). Keep `Pending`, `RESTART_PROMPT`, `buildChildEnv`, `MESSAGE_MAX`, `STOP_ALL_TIMEOUT_MS`, `RECONCILE_TIMEOUT_MS`.

The class head:

```ts
/**
 * Glue between the agent lifecycle and the ACP driver: picks the engine
 * from the agent's model id, starts it when an agent's setup completes,
 * delivers the persona the way the engine takes it, turns prompts into
 * turns with working/idle status around them, folds the stream into the
 * store and the usage table, and stops the child when the agent stops.
 */
export class HarnessSupervisor {
  private readonly driver: HarnessDriver;
  private readonly streams: StreamRecorder;
  private readonly usage: UsageRecorder;
  private readonly resolveBinary: (
    bin: string,
    env: NodeJS.ProcessEnv
  ) => Promise<string>;
  private readonly context = new Map<
    string,
    { sessionId: string; engine: HarnessEngineId; model: string }
  >();
  /**
   * Persona text an engine takes as the leading block of its first prompt
   * (see EngineSpec.personaDelivery); set at a fresh start, consumed by the
   * first turn, never set for a resumed session.
   */
  private readonly pendingPersona = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, Pending[]>();
  private readonly running = new Map<string, Pending>();

  constructor(private readonly deps: SupervisorDeps) {
    this.resolveBinary = deps.resolveBinary ?? resolveExecutable;
    this.driver =
      deps.driver ??
      new HarnessDriver({ logger: deps.logger, resolveBinary: this.resolveBinary });
    this.streams = new StreamRecorder(new StreamStore(deps.pool), {
      // A round the engine ran on its own settles by going quiet; the view
      // learns of it the same way it learns of every other stream write.
      onAutonomousSettled: (agentId) => deps.publishHarness(agentId, true),
    });
    this.usage = new UsageRecorder(deps.pool);
    this.driver.onEvent((event) => {
      const prior = this.queues.get(event.agentId) ?? Promise.resolve();
      const next = prior.then(() => this.onEvent(event));
      this.queues.set(event.agentId, next);
      void next.finally(() => {
        if (this.queues.get(event.agentId) === next) {
          this.queues.delete(event.agentId);
        }
      });
    });
  }
```

Keep `isRunning`, `isBusy`, `pendingOf`, `listQueued`, `removeQueued`, `promoteQueued`, `interrupt`, `sendQueuedNow` unchanged. Replace `getConfigOptions`, `setConfigOption`, and delete `modelCatalog` and `overlayDir`:

```ts
  /** The running session's options (model, effort); null when not running. */
  getConfigOptions(agentId: string): HarnessConfigOption[] | null {
    const options = this.driver.getConfigOptions(agentId);
    return options ? (options as HarnessConfigOption[]) : null;
  }

  /** The slash commands the engine advertised; null when not running. */
  getCommands(agentId: string): HarnessCommand[] | null {
    const commands = this.driver.getCommands(agentId);
    return commands
      ? commands.map((c) => ({
          name: c.name,
          description: c.description,
          ...(c.input ? { input: { hint: c.input.hint } } : {}),
        }))
      : null;
  }

  /** Switch a session option; a model switch is also stored on the agent as engine/model. */
  async setConfigOption(
    agentId: string,
    configId: string,
    value: string
  ): Promise<HarnessConfigOption[]> {
    const options = await this.driver.setConfigOption(agentId, configId, value);
    const ctx = this.context.get(agentId);
    if (ctx && isModelOption(options as HarnessConfigOption[], configId)) {
      ctx.model = value;
      await this.deps.setAgentModel?.(agentId, `${ctx.engine}/${value}`);
    }
    // Another client's picker shows the switch without waiting for a poll.
    this.deps.publishHarness(agentId, true);
    return options as HarnessConfigOption[];
  }
```

Add the module-level helper next to `buildChildEnv`:

```ts
/** The `model` option: by id, or by ACP category for engines that name it otherwise. */
export function modelOptionOf(
  options: readonly HarnessConfigOption[]
): HarnessConfigOption | undefined {
  return options.find((o) => o.id === "model" || o.category === "model");
}

function isModelOption(
  options: readonly HarnessConfigOption[],
  configId: string
): boolean {
  return modelOptionOf(options)?.id === configId;
}
```

Replace `start()`:

```ts
  async start(agentId: string): Promise<{ resumed: boolean }> {
    const agent = await this.deps.getAgent(agentId);
    if (!agent || agent.type !== "dispatch") {
      throw new Error(`${agentId} is not a Dispatch Harness agent`);
    }
    const { engine, model } = splitModelId(agent.model ?? DEFAULT_HARNESS_MODEL);
    // Rows a previous process left open (restart mid-turn) settle first,
    // so the view never shows a turn that can no longer finish.
    await this.streams.reconcile(agentId);
    const jobRunId = (await this.deps.activeJobRunIdFor?.(agentId)) ?? null;
    const persona = await this.deps.personaPromptFor(agent, jobRunId);
    const mediaDir = resolveMediaDir(
      agentId,
      agent.mediaDir,
      this.deps.config.mediaRoot
    );
    const env = buildChildEnv({ agentId, mediaDir, config: this.deps.config });
    const spec = engineSpecFor(engine, model, await this.binsFor(engine, env));
    this.streams.setCwd(agentId, agent.cwd);
    const session = await this.driver.start({
      agentId,
      cwd: agent.cwd,
      engine: spec,
      systemPromptAppend:
        spec.personaDelivery === "system_prompt" ? persona : null,
      mcp: {
        url: dispatchMcpUrl(this.deps.config, agentId, jobRunId ?? undefined),
        token: jobRunId
          ? createJobMcpToken(this.deps.config.authToken, jobRunId, agentId)
          : createAgentMcpToken(this.deps.config.authToken, agentId),
      },
      sessionId: agent.cliSessionId ?? null,
      env,
    });
    const { sessionId, resumed } = session;
    this.context.set(agentId, { sessionId, engine, model });
    // An engine that takes the persona in its first prompt gets it once,
    // on a fresh session; a resumed session already has it in its history.
    if (spec.personaDelivery === "first_prompt" && !resumed) {
      this.pendingPersona.set(agentId, persona);
    } else {
      this.pendingPersona.delete(agentId);
    }
    if (model !== "default" && !spec.modelFixedAtLaunch) {
      await this.applyModel(agentId, model);
    }
    await this.deps.setCliSessionId(agentId, sessionId);
    await this.deps.setLatestEvent(agentId, {
      type: "idle",
      message: resumed ? "Harness session resumed." : "Harness session started.",
    });
    // The session's options exist from here: the picker can read them.
    this.deps.publishHarness(agentId, true);
    // A fresh session gets the launch prompt as its first turn; a resumed
    // one already had it.
    if (!agent.cliSessionId) {
      const first = await this.deps.launchPromptFor(agentId);
      if (first) {
        this.enqueuePrompt(agentId, first).settled.catch((err: unknown) => {
          this.deps.logger.warn({ err, agentId }, "harness first turn failed");
        });
      }
    }
    return { resumed };
  }

  /**
   * The binaries a spec needs, resolved to absolute paths: an engine's
   * adapter finds the host CLI through an env var, and the service's PATH
   * is not a login shell's. The host codex is only named when configured.
   */
  private async binsFor(
    engine: HarnessEngineId,
    env: NodeJS.ProcessEnv
  ): Promise<EngineBins> {
    const c = this.deps.config;
    return {
      claudeHarnessBin: c.claudeHarnessBin,
      codexHarnessBin: c.codexHarnessBin,
      geminiBin: c.geminiBin,
      opencodeBin: c.opencodeBin,
      claudeBin:
        engine === "claude" ? await this.resolveBinary(c.claudeBin, env) : c.claudeBin,
      codexBin:
        engine === "codex" && process.env.DISPATCH_CODEX_BIN
          ? await this.resolveBinary(c.codexBin, env)
          : null,
    };
  }

  /** A stored model that is not the engine's default is applied through its model option. */
  private async applyModel(agentId: string, model: string): Promise<void> {
    const options = this.driver.getConfigOptions(agentId) ?? [];
    const option = modelOptionOf(options as HarnessConfigOption[]);
    if (!option) {
      this.deps.logger.warn(
        { agentId, model },
        "the engine publishes no model option; keeping its default model"
      );
      return;
    }
    try {
      await this.driver.setConfigOption(agentId, option.id, model);
    } catch (err) {
      this.deps.logger.warn(
        { err, agentId, model },
        "the engine refused the stored model; keeping its default"
      );
    }
  }
```

In `runTurn`, prepend the pending persona before the prompt goes out:

```ts
  private async runTurn(
    agentId: string,
    text: string,
    isLastQueued: () => boolean
  ): Promise<void> {
    let startedAt: string | null = null;
    const persona = this.pendingPersona.get(agentId);
    if (persona !== undefined) {
      this.pendingPersona.delete(agentId);
      text = `${persona}\n\n${text}`;
    }
    try {
```

(The rest of `runTurn` is unchanged; `parsePromptSource` still finds the chat header because it matches at any line start.)

In `stop()`, replace the overlay removal with `this.pendingPersona.delete(agentId);`. In `onEvent`, the exit message becomes `` `The engine exited (${event.code ?? event.signal ?? "unknown"}); press Start to relaunch.` `` and the warn becomes `"harness event handling failed"`. In `restoreRunning`, the warns become `"harness restart follow-up turn failed"` and `"harness agent could not be restored at boot"`. In `runTurn`'s catch, `"harness prompt failed"`. Remove the `import path from "node:path"` line if nothing else uses it.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-supervisor.test.ts`
Expected: PASS, including every pre-existing test (restart resume window, queue ordering, Send now, stop flushes the queue).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agents/harness/supervisor.ts apps/server/test/harness-supervisor.test.ts
git commit -m "feat(harness): pick the engine from the model id and deliver the persona per engine

The supervisor splits agent.model into engine and model, resolves the
engine's binaries, hands the driver the spec, and delivers the persona
in _meta for Claude or as the first prompt's leading block for the
other engines. A stored model goes through the session's model option;
an engine without one keeps its default. The dsh overlay, credential
snapshot, provider filter and catalog probe are gone.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Usage report, commands route, and the budgets keyed by engine

**Files:**

- Create: `apps/server/src/agents/harness/usage.ts` (after deleting the dsh `usage.ts` in this task's Step 3, so the name is free)
- Modify: `apps/server/src/routes/agents/harness-routes.ts`
- Modify: `apps/server/src/routes/agents/shared.ts:24-45`
- Modify: `apps/server/src/routes/system.ts:65-69,98-109,469-475`
- Modify: `apps/server/src/usage-budget-settings.ts`
- Test: `apps/server/test/harness-usage-report.test.ts` (new), `apps/server/test/harness-routes.test.ts`

**Interfaces:**

- Produces:

```ts
// agents/harness/usage.ts
export function monthStartUtc(now?: Date): Date;
export async function loadUsageReport(db: Queryable, budgets: UsageBudgets, now?: Date): Promise<HarnessUsageResponse>;
export async function loadAgentUsage(db: Queryable, agentId: string, now?: Date): Promise<HarnessUsageAgent | null>;
// routes
GET /api/v1/agents/:id/harness/commands -> HarnessCommandsResponse
GET /api/v1/agents/:id/harness/usage    -> { agent: HarnessUsageAgent | null; monthStart: string }
GET /api/v1/harness/usage               -> HarnessUsageResponse  (existing path, new shape)
// AgentRouteDeps.harness gains getCommands(agentId): HarnessCommand[] | null; dshHome and subagentLogs are removed
```

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/harness-usage-report.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  loadAgentUsage,
  loadUsageReport,
  monthStartUtc,
} from "../src/agents/harness/usage.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
const NOW = new Date(Date.UTC(2026, 8, 7, 12, 0, 0));

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});
afterAll(async () => {
  await teardownTestDb();
});
beforeEach(async () => {
  await pool.query("DELETE FROM agent_stream_events");
  await pool.query("DELETE FROM agent_token_usage");
  await pool.query("DELETE FROM agents");
});

async function agent(id: string, name: string, model: string) {
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status, type, model) VALUES ($1, $2, '/tmp', 'running', 'dispatch', $3)`,
    [id, name, model]
  );
}

async function tokens(
  agentId: string,
  session: string,
  input: number,
  output: number,
  at: Date
) {
  await pool.query(
    `INSERT INTO agent_token_usage (agent_id, session_id, model, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, message_count, session_start, session_end)
     VALUES ($1, $2, 'm', $3, 0, 0, $4, 1, $5, $5)`,
    [agentId, session, input, output, at]
  );
}

async function turn(agentId: string, seq: number, usage: unknown, at: Date) {
  await pool.query(
    `INSERT INTO agent_stream_events (agent_id, seq, kind, payload, created_at, updated_at)
     VALUES ($1, $2, 'turn', $3::jsonb, $4, $4)`,
    [
      agentId,
      seq,
      JSON.stringify({
        state: "settled",
        prompt: { source: "system", text: "x" },
        usage,
      }),
      at,
    ]
  );
}

describe("monthStartUtc", () => {
  it("is midnight UTC on the first", () => {
    expect(monthStartUtc(NOW).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("loadUsageReport", () => {
  it("groups agents by engine with tokens from agent_token_usage and the newest cost from turn rows", async () => {
    await agent("agt_a", "A", "claude/default");
    await agent("agt_b", "B", "codex/gpt-5.6-sol");
    await agent("agt_c", "C", "gemini/default");
    await tokens("agt_a", "s1", 1000, 200, NOW);
    await tokens("agt_a", "s1", 1000, 200, new Date(Date.UTC(2026, 7, 30))); // last month, ignored
    await tokens("agt_b", "s2", 50, 5, NOW);
    await turn(
      "agt_a",
      1,
      { used: 100, size: 1000, cost: { amount: 0.1, currency: "USD" } },
      NOW
    );
    await turn(
      "agt_a",
      2,
      { used: 200, size: 1000, cost: { amount: 0.35, currency: "USD" } },
      NOW
    );
    await turn("agt_b", 1, { used: 200, size: 1000 }, NOW);
    const report = await loadUsageReport(pool, { claude: 20 }, NOW);
    expect(report.monthStart).toBe("2026-09-01T00:00:00.000Z");
    const by = Object.fromEntries(report.engines.map((e) => [e.id, e]));
    expect(by.claude).toMatchObject({
      tokens: 1200,
      costUsd: 0.35,
      budgetUsd: 20,
      agents: [{ agentId: "agt_a", name: "A", tokens: 1200, costUsd: 0.35 }],
    });
    expect(by.codex).toMatchObject({
      tokens: 55,
      costUsd: null,
      budgetUsd: null,
      agents: [{ agentId: "agt_b", name: "B", tokens: 55, costUsd: null }],
    });
    expect(by.gemini).toMatchObject({
      tokens: 0,
      costUsd: null,
      agents: [{ agentId: "agt_c", tokens: 0, costUsd: null }],
    });
    expect(by.opencode).toMatchObject({ tokens: 0, costUsd: null, agents: [] });
  });

  it("ignores non-harness agents and agents with an unknown engine", async () => {
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status, type, model) VALUES ('agt_t', 'T', '/tmp', 'running', 'claude', 'opus')`
    );
    await agent("agt_u", "U", "unknown/x");
    const report = await loadUsageReport(pool, {}, NOW);
    expect(report.engines.flatMap((e) => e.agents)).toEqual([]);
  });
});

describe("loadAgentUsage", () => {
  it("returns one agent's month, or null for an unknown agent", async () => {
    await agent("agt_a", "A", "opencode/default");
    await tokens("agt_a", "s1", 10, 1, NOW);
    await turn(
      "agt_a",
      1,
      { used: 1, size: 2, cost: { amount: 1.25, currency: "USD" } },
      NOW
    );
    expect(await loadAgentUsage(pool, "agt_a", NOW)).toEqual({
      agentId: "agt_a",
      name: "A",
      tokens: 11,
      costUsd: 1.25,
    });
    expect(await loadAgentUsage(pool, "agt_nope", NOW)).toBeNull();
  });
});
```

In `apps/server/test/harness-routes.test.ts`: change the context setup to `const ctx = useInjectApp();` (no `DISPATCH_DSH_HOME`), delete the `dshHome` `mkdtemp`, the `zstdCompressSync` import and every test under a `describe` that mentions `subagents` or `skills`, and add:

```ts
describe("GET /api/v1/agents/:id/harness/commands", () => {
  it("404s for an unknown agent and returns an empty list for one with no live session", async () => {
    expect(
      (await authedGet("/api/v1/agents/agt_nope/harness/commands")).statusCode
    ).toBe(404);
    const res = await authedGet(`/api/v1/agents/${agentId}/harness/commands`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ commands: [] });
  });
});

describe("GET /api/v1/agents/:id/harness/usage", () => {
  it("reports the agent's month, null cost when the engine sent none", async () => {
    await ctx.pool.query(
      `UPDATE agents SET type = 'dispatch', model = 'codex/default' WHERE id = $1`,
      [agentId]
    );
    const res = await authedGet(`/api/v1/agents/${agentId}/harness/usage`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      agent: { agentId, tokens: 0, costUsd: null },
    });
    expect(typeof res.json().monthStart).toBe("string");
  });
});

describe("GET /api/v1/harness/usage", () => {
  it("lists the four engines", async () => {
    const res = await authedGet("/api/v1/harness/usage");
    expect(res.statusCode).toBe(200);
    expect(res.json().engines.map((e: { id: string }) => e.id)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-usage-report.test.ts test/harness-routes.test.ts`
Expected: FAIL: the usage module does not exist; `/commands` 404s on the known agent; `/api/v1/harness/usage` returns the dsh provider shape.

- [ ] **Step 3: Replace the usage module**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git rm -q apps/server/src/agents/harness/usage.ts apps/server/src/agents/harness/codex-usage.ts apps/server/src/agents/harness/usage-http.ts
git rm -q apps/server/test/harness-usage.test.ts
```

Create `apps/server/src/agents/harness/usage.ts`:

```ts
import {
  HARNESS_ENGINES,
  harnessEngineOf,
  type HarnessUsageAgent,
  type HarnessUsageEngine,
  type HarnessUsageResponse,
  type UsageBudgets,
} from "@dispatch/shared";

import type { Queryable } from "../../chat/store.js";

/**
 * What the harness engines have used this month. Tokens come from
 * `agent_token_usage`, which the usage recorder fills from each prompt
 * response's cumulative counts. Cost comes from the newest turn row that
 * carries a `usage.cost`: an engine reports its running total for the
 * current session, so this is the current session's spend, and a session
 * the agent ran earlier in the month is not added to it.
 */

export function monthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

type AgentRow = {
  id: string;
  name: string;
  model: string | null;
  tokens: string | number;
  cost_amount: string | number | null;
  cost_currency: string | null;
};

const AGENTS_SQL = `
  WITH tokens AS (
    SELECT agent_id,
           SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
      FROM agent_token_usage
     WHERE session_end >= $1
     GROUP BY agent_id
  ),
  cost AS (
    SELECT DISTINCT ON (agent_id) agent_id,
           (payload->'usage'->'cost'->>'amount')::float8 AS amount,
           payload->'usage'->'cost'->>'currency' AS currency
      FROM agent_stream_events
     WHERE kind = 'turn' AND created_at >= $1
       AND payload->'usage'->'cost' IS NOT NULL
     ORDER BY agent_id, seq DESC
  )
  SELECT a.id, a.name, a.model,
         COALESCE(t.tokens, 0) AS tokens,
         c.amount AS cost_amount, c.currency AS cost_currency
    FROM agents a
    LEFT JOIN tokens t ON t.agent_id = a.id
    LEFT JOIN cost c ON c.agent_id = a.id
   WHERE a.type = 'dispatch' AND a.deleted_at IS NULL`;

function toAgent(row: AgentRow): HarnessUsageAgent {
  return {
    agentId: row.id,
    name: row.name,
    tokens: Number(row.tokens),
    costUsd:
      row.cost_amount !== null && row.cost_currency === "USD"
        ? Number(row.cost_amount)
        : null,
  };
}

export async function loadUsageReport(
  db: Queryable,
  budgets: UsageBudgets,
  now: Date = new Date()
): Promise<HarnessUsageResponse> {
  const monthStart = monthStartUtc(now);
  const result = await db.query<AgentRow>(`${AGENTS_SQL} ORDER BY a.name`, [
    monthStart,
  ]);
  const engines: HarnessUsageEngine[] = HARNESS_ENGINES.map((engine) => ({
    ...engine,
    tokens: 0,
    costUsd: null,
    budgetUsd: engine.reportsCost ? (budgets[engine.id] ?? null) : null,
    agents: [],
  }));
  for (const row of result.rows) {
    const engine = harnessEngineOf(row.model);
    if (!engine) continue;
    const bucket = engines.find((e) => e.id === engine.id);
    if (!bucket) continue;
    const agent = toAgent(row);
    bucket.agents.push(agent);
    bucket.tokens += agent.tokens;
    if (agent.costUsd !== null) {
      bucket.costUsd = (bucket.costUsd ?? 0) + agent.costUsd;
    }
  }
  return {
    generatedAt: now.toISOString(),
    monthStart: monthStart.toISOString(),
    engines,
  };
}

export async function loadAgentUsage(
  db: Queryable,
  agentId: string,
  now: Date = new Date()
): Promise<HarnessUsageAgent | null> {
  const result = await db.query<AgentRow>(`${AGENTS_SQL} AND a.id = $2`, [
    monthStartUtc(now),
    agentId,
  ]);
  const row = result.rows[0];
  return row ? toAgent(row) : null;
}
```

- [ ] **Step 4: Rewrite the routes and their deps**

`apps/server/src/routes/agents/shared.ts`: delete the `dshHome` and `subagentLogs` fields (and the `SessionLogReader` import), and add to `harness`:

```ts
  harness: {
    getConfigOptions: (agentId: string) => HarnessConfigOption[] | null;
    setConfigOption: (
      agentId: string,
      configId: string,
      value: string
    ) => Promise<HarnessConfigOption[]>;
    /** The slash commands the engine advertised; null when not running. */
    getCommands: (agentId: string) => HarnessCommand[] | null;
    listQueued: (agentId: string) => QueuedPrompt[];
    sendQueuedNow: (agentId: string, id: string) => Promise<boolean>;
    removeQueued: (agentId: string, id: string) => boolean;
    interrupt: (agentId: string) => Promise<boolean>;
  };
```

(`HarnessCommand` joins the `@dispatch/shared` import.)

`apps/server/src/routes/agents/harness-routes.ts`: imports and the deps type become

```ts
import type { FastifyInstance } from "fastify";
import type {
  HarnessCommandsResponse,
  HarnessConfigResponse,
  HarnessConfigUpdateRequest,
  HarnessPathsResponse,
  HarnessTurnsResponse,
} from "@dispatch/shared";

import { listHarnessPaths } from "../../agents/harness/paths.js";
import { loadQueued, loadTurns } from "../../agents/harness/turns.js";
import { loadAgentUsage, monthStartUtc } from "../../agents/harness/usage.js";
import type { AgentRouteDeps } from "./shared.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** The Harness view's routes: turns and the queue, session config, commands, usage, paths. */
export async function registerAgentHarnessRoutes(
  app: FastifyInstance,
  deps: Pick<AgentRouteDeps, "pool" | "harness">
): Promise<void> {
```

(`listDshPaths` in `paths.ts` is renamed `listHarnessPaths` in the same commit; its `dshHome` option, if any, is removed.) Delete the whole `/api/v1/agents/:id/harness/subagents/:sessionId` route. Replace the skills route with:

```ts
// The slash commands the engine advertises, for the composer's "/" menu.
app.get("/api/v1/agents/:id/harness/commands", async (request, reply) => {
  const id = (request.params as { id?: string }).id ?? "";
  if (!(await exists(id))) {
    return reply.code(404).send({ error: "Agent not found." });
  }
  const response: HarnessCommandsResponse = {
    commands: deps.harness.getCommands(id) ?? [],
  };
  return response;
});

// This agent's tokens and cost this month, for the usage chip.
app.get("/api/v1/agents/:id/harness/usage", async (request, reply) => {
  const id = (request.params as { id?: string }).id ?? "";
  if (!(await exists(id))) {
    return reply.code(404).send({ error: "Agent not found." });
  }
  return {
    agent: await loadAgentUsage(deps.pool, id),
    monthStart: monthStartUtc().toISOString(),
  };
});
```

`apps/server/src/routes/system.ts`: delete the `dshModels` dep and make the models route static; keep `usageReport` with its new type:

```ts
  /** What the harness engines have used this month (agents/harness/usage.ts). */
  usageReport?: () => Promise<HarnessUsageResponse>;
```

```ts
app.get("/api/v1/agent-models", async () => {
  return { models: AGENT_MODEL_OPTIONS };
});
```

The existing `/api/v1/harness/usage` handler at line 469 keeps calling `deps.usageReport()`; nothing else changes there.

`apps/server/src/usage-budget-settings.ts`: swap the registry:

```ts
import {
  HARNESS_BUDGET_ENGINE_IDS,
  type HarnessEngineId,
  type UsageBudgets,
} from "@dispatch/shared";
// ...
const ENGINE_IDS = new Set<string>(HARNESS_BUDGET_ENGINE_IDS);

/** A cost-reporting engine id: the only kind a dollar budget can name. */
export function isUsageEngineId(id: unknown): id is HarnessEngineId {
  return typeof id === "string" && ENGINE_IDS.has(id);
}
```

and in `parseUsageBudgets` replace `isUsageProviderId` with `isUsageEngineId` and the error text with `` `Unknown engine: ${id}.` ``. Update its test file (`grep -l usage-budget apps/server/test`) to use `claude` and `opencode` as valid ids and `deepseek` as an unknown one.

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-usage-report.test.ts test/harness-routes.test.ts`
Expected: PASS. (`server.ts` still fails to type check until Task 10 wires `getCommands` and drops the deleted imports; that is expected here.)

- [ ] **Step 6: Commit**

```bash
git add -A apps/server/src/agents/harness apps/server/src/routes apps/server/src/usage-budget-settings.ts apps/server/test
git commit -m "feat(harness): commands route and a usage report by engine

/harness/commands serves the slash commands the engine advertised.
Usage is read from agent_token_usage and the newest turn cost per agent,
grouped by engine, with budgets on the two engines that report cost. The
dsh price table, provider billing clients and subagent log route go.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Config, model catalog, manager and server wiring

**Files:**

- Modify: `apps/server/src/config.ts:16-34,91-105`
- Modify: `apps/server/src/shared/agent-models.ts:50-69`
- Modify: `apps/server/src/agents/manager.ts:355-365,407-414`
- Modify: `apps/server/src/server.ts:21-23,480-510,767-775,869-881,1050-1073,1117-1122`
- Modify: `.env.example`

**Interfaces:**

- Produces: `AppConfig.claudeHarnessBin`, `codexHarnessBin`, `geminiBin`; `dshBin`/`dshHome` gone. `AGENT_MODEL_OPTIONS.dispatch` lists engine-prefixed ids with `group` set to the engine label.

- [ ] **Step 1: Config**

In `apps/server/src/config.ts` replace the `dshBin`/`dshHome` fields of `AppConfig` with:

```ts
/** The Claude engine's ACP adapter (`claude-agent-acp`). */
claudeHarnessBin: string;
/** The Codex engine's ACP adapter (`codex-acp`). */
codexHarnessBin: string;
/** The Gemini CLI, which speaks ACP itself. */
geminiBin: string;
```

and the two `loadConfig` entries with:

```ts
    claudeHarnessBin:
      process.env.DISPATCH_CLAUDE_HARNESS_BIN ?? "claude-agent-acp",
    codexHarnessBin: process.env.DISPATCH_CODEX_HARNESS_BIN ?? "codex-acp",
    geminiBin:
      process.env.DISPATCH_GEMINI_BIN ?? process.env.GEMINI_BIN ?? "gemini",
```

Remove the now-unused `os` import only if `mediaRoot` no longer needs it (it does; keep it).

- [ ] **Step 2: Model catalog**

In `apps/server/src/shared/agent-models.ts` replace the `dispatch:` entry and its comment with:

```ts
  // Dispatch Harness ids are `engine/model`. The engine picks the ACP agent;
  // the model half is what that engine calls it, or `default` for the
  // engine's own default. The picker inside a running session reads the
  // engine's live options; this list is for the create dialog.
  dispatch: [
    { id: "claude/default", label: "Claude Code default", group: "Claude Code" },
    { id: "claude/claude-fable-5-1", label: "Fable 5.1", group: "Claude Code" },
    { id: "claude/claude-opus-5", label: "Opus 5", group: "Claude Code" },
    { id: "claude/claude-sonnet-5", label: "Sonnet 5", group: "Claude Code" },
    { id: "claude/claude-haiku-4-5-20251001", label: "Haiku 4.5", group: "Claude Code" },
    { id: "codex/default", label: "Codex default", group: "Codex" },
    { id: "codex/gpt-6-astra", label: "GPT-6 Astra", group: "Codex" },
    { id: "codex/gpt-5.6-sol", label: "GPT-5.6 Sol", group: "Codex" },
    { id: "codex/gpt-5.6-terra", label: "GPT-5.6 Terra", group: "Codex" },
    { id: "codex/gpt-5.6-luna", label: "GPT-5.6 Luna", group: "Codex" },
    { id: "codex/gpt-5.5", label: "GPT-5.5", group: "Codex" },
    { id: "codex/gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark (preview)", group: "Codex" },
    { id: "gemini/default", label: "Gemini CLI default (gemini-2.5-pro)", group: "Gemini CLI" },
    { id: "gemini/gemini-3-pro-preview", label: "Gemini 3 Pro (preview)", group: "Gemini CLI" },
    { id: "gemini/gemini-3-flash-preview", label: "Gemini 3 Flash (preview)", group: "Gemini CLI" },
    { id: "gemini/gemini-3.5-flash", label: "Gemini 3.5 Flash", group: "Gemini CLI" },
    { id: "gemini/gemini-2.5-pro", label: "Gemini 2.5 Pro", group: "Gemini CLI" },
    { id: "gemini/gemini-2.5-flash", label: "Gemini 2.5 Flash", group: "Gemini CLI" },
    { id: "opencode/default", label: "OpenCode default", group: "OpenCode" },
  ],
```

- [ ] **Step 2b: The tmux launcher's Console for a harness agent**

`apps/server/src/agents/tmux/command-builder.ts` still names `dshBin` and tails the dsh command log in a split. Three edits:

Delete line 13, `import { commandLogPath } from "../harness/command-log.js";` (Task 1 renamed the path; Task 11 deletes the module).

The `CLI_BY_AGENT_TYPE` map (lines 22 to 33): the `Pick<AppConfig, ...>` union loses `"dshBin"` and gains `"claudeHarnessBin"`, and the `dispatch` row becomes:

```ts
  // Never read: the `dispatch` branch below returns before the lookup. The
  // supervisor spawns the engine; the pane is the human's shell.
  dispatch: "claudeHarnessBin",
```

The Console block (lines 556 to 579) becomes a plain login shell for both types:

```ts
// Terminal agents have no CLI to launch: drop the user into an
// interactive login shell in the chosen cwd/worktree. `-l` alone starts a
// non-interactive login shell that exits immediately under `bash -c`,
// which tears down the tmux session before the browser can attach.
// Harness agents get the same shell: the ACP supervisor (agents/harness)
// owns the engine process, and the pane is the human's console into the
// worktree.
if (type === "terminal" || type === "dispatch") {
  return `${envPrefix} "\${SHELL:-/bin/bash}" -il`;
}
```

Remove the now-unused `path` import from that file if `path.dirname` was its only use (`grep -n 'path\.' apps/server/src/agents/tmux/command-builder.ts`).

- [ ] **Step 3: Manager wording**

In `apps/server/src/agents/manager.ts`: the 409 message becomes `"The harness is not running for this agent; the prompt cannot be delivered."`, the 500 becomes `"The harness supervisor is not attached."`, and `markHarnessStartFailed`'s message becomes `` `The harness did not come back after restart: ${message}`.slice(0, 200) ``. Reword the four comments that say "dsh agent" to "harness agent" and "dsh first turn" to "harness first turn".

- [ ] **Step 4: Server wiring**

In `apps/server/src/server.ts`:

```ts
import { HarnessSupervisor } from "./agents/harness/supervisor.js";
import { loadUsageReport } from "./agents/harness/usage.js";
```

(delete the `createSessionLogReader` and `createUsageReporter` imports). The supervisor construction keeps its deps as they are. In `registerSystemRoutes` delete the `dshModels` line and replace `usageReport`:

```ts
    usageReport: () => loadUsageReport(pool, () => getUsageBudgets(pool)),
```

Wait: `loadUsageReport` takes the budgets object, not a getter. Use:

```ts
    usageReport: async () =>
      loadUsageReport(pool, await getUsageBudgets(pool)),
```

In `registerAgentRoutes` delete `dshHome:` and `subagentLogs:` and add `getCommands: (agentId) => harnessSupervisor.getCommands(agentId),` inside `harness`. Reword the three comments and two log strings: `"Restored harness agents after restart"`, `"Stopping harness agents on shutdown failed"`, and the comments "harness children died with the previous process", "Stop harness children through their teardown ladder", "A harness prompt waits in the supervisor's turn queue".

- [ ] **Step 5: `.env.example`**

Append:

```bash

# Dispatch Harness engines (agent type "dispatch"). Each is a host install the
# service resolves with its own PATH, so use absolute paths. The engine is the
# first segment of the agent's model id: claude/…, codex/…, gemini/…, opencode/….
# DISPATCH_CLAUDE_HARNESS_BIN=~/.local/bin/claude-agent-acp
# DISPATCH_CODEX_HARNESS_BIN=~/.local/bin/codex-acp
# DISPATCH_GEMINI_BIN=~/.local/bin/gemini
# DISPATCH_OPENCODE_BIN=~/.local/bin/opencode
# The engines use the host CLIs' own logins (claude /login, codex login
# --device-auth, NO_BROWSER=true gemini, opencode auth login); no key here.
```

- [ ] **Step 6: Type check and run the route suite**

Run: `pnpm --filter @dispatch/server check`
Expected: exit 0.

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run test/harness-routes.test.ts test/agent-type-settings.test.ts test/release-routes.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/shared/agent-models.ts apps/server/src/agents/manager.ts apps/server/src/server.ts .env.example
git commit -m "feat(server): engine binaries in config, engine-prefixed catalog, harness wiring

DISPATCH_CLAUDE_HARNESS_BIN, DISPATCH_CODEX_HARNESS_BIN and
DISPATCH_GEMINI_BIN join the existing CLI settings; dshBin and dshHome
go. The dispatch catalog lists engine/model ids grouped by engine, and
the server wires the supervisor's commands and usage report into the
routes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Delete the dsh-only modules, tests and the zstd smoke

**Files:**

- Delete: `apps/server/src/agents/harness/{overlay,session-log,subagents,credentials,command-log,skills}.ts`
- Delete: `apps/server/test/harness-{overlay,session-log,subagents,credentials,command-log,skills,config-options}.test.ts`, `apps/server/test/bun-session-log.smoke.ts`
- Modify: `apps/server/package.json:12`
- Modify: `apps/server/src/agents/harness/persona.ts`, `paths.ts` (wording)

- [ ] **Step 1: Remove the files**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git rm -q apps/server/src/agents/harness/{overlay,session-log,subagents,credentials,command-log,skills}.ts
for t in overlay session-log subagents credentials command-log skills config-options; do
  [ -f "apps/server/test/harness-$t.test.ts" ] && git rm -q "apps/server/test/harness-$t.test.ts"
done
git rm -q apps/server/test/bun-session-log.smoke.ts
sed -i 's| \&\& bun test/bun-session-log.smoke.ts||' apps/server/package.json
grep -n '"test"' apps/server/package.json
```

Expected last line: `"test": "bun run prepare:runtime-assets && bash ../../scripts/server-tests-isolated.sh run",`

- [ ] **Step 2: Wording in the survivors**

In `apps/server/src/agents/harness/persona.ts` rename the constants and function (Task 1 did the identifiers; fix the prose): the header comment "The system-prompt persona for a harness agent. CLI agents get the same pieces as separate `--append-system-prompt` flags; the harness takes one persona string (in `_meta.systemPrompt.append` for Claude, as the first prompt's leading block for the other engines), so this joins them." Delete the `{{model}}` / `{{cwd}}` sentence. `HARNESS_SLASH_RULE` reads: `'A user message that begins with "/<name>" names a slash command or skill: run it, treating the rest of the message as its input. If none has that name, say so briefly.'` `HARNESS_CHAT_RULE` keeps its text.

In `apps/server/src/agents/harness/paths.ts` rename `listDshPaths` to `listHarnessPaths` (Task 9 imported that name) and reword any "dsh" in comments.

Comments elsewhere that still say dsh, each a one-line reword to "a harness agent" / "the harness": `apps/server/src/chat/envelope.ts:69`, `apps/server/src/chat/store.ts:42` and `:80`, `apps/server/src/chat/service.ts:148` and `:521`, `apps/server/src/chat/user-prompt.ts:41`, `apps/server/src/agents/activity-monitor.ts` and `token-harvester.ts` (their dsh early-return comments), and `apps/server/src/server/agent-prompts.ts:46` (`"harness turn failed"`).

- [ ] **Step 3: Prove nothing dsh remains**

Run:

```bash
cd /home/nii/.dispatch/server-dsh-harness
grep -rniE '\bdsh\b|deepseek|DSH_|dshBin|dshHome' apps/server/src apps/server/test packages/shared/src apps/server/package.json .env.example
```

Expected: no output. (Web hits are plan 2's; e2e, scripts and docs are plan 3's.)

- [ ] **Step 4: Type check and run the whole server suite**

Run: `pnpm --filter @dispatch/server check`
Expected: exit 0.

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run`
Expected: every file passes. If `harness-persona.test.ts` asserts the old slash-rule text, update the expected string to the new `HARNESS_SLASH_RULE`.

- [ ] **Step 5: Commit**

```bash
git add -A apps/server
git commit -m "refactor(harness): delete the dsh-only modules

The overlay writer, zstd session-log reader, subagent shaper,
credential store, command log and skills scan existed for one child
process; the engines take persona, subagents and commands over ACP, so
nothing reads them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Server gate

- [ ] **Step 1: Type check**

Run: `cd /home/nii/.dispatch/server-dsh-harness && pnpm --filter @dispatch/server check && pnpm --filter @dispatch/shared check 2>/dev/null || true`
Expected: server check exits 0.

- [ ] **Step 2: Full server suite**

Run: `cd apps/server && bash ../../scripts/server-tests-isolated.sh run`
Expected: all green. Note the count in the commit message of plan 2's first task if anything changed.

- [ ] **Step 3: Working tree**

Run: `git status --porcelain -uno`
Expected: only `pnpm-workspace.yaml` (the local `allowBuilds` line). Commit it on its own:

```bash
git add pnpm-workspace.yaml
git commit -m "chore: approve native builds for pnpm 11

pnpm 11 no longer reads package.json#pnpm.onlyBuiltDependencies, so the
esbuild, sharp and workerd postinstalls were skipped and the web build
failed. allowBuilds in pnpm-workspace.yaml is the setting it reads.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

`pnpm run check` at the repo root still fails on `apps/web` until plan 2 lands; that is expected and is plan 2's first gate.

---

## Self-review against the spec

| Spec section                                                                 | Task                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engines table (bin, args, env, full access, persona, subagents, model)       | 4, 5, 8                                                                                                                                                                                                                                                                                                                                                                       |
| Session setup (`_meta`, `session/resume`, `set_mode`, `set_config_option`)   | 5, 8                                                                                                                                                                                                                                                                                                                                                                          |
| The stream (`plan`, `plan_update`, `usage_update`, ignored kinds)            | 6                                                                                                                                                                                                                                                                                                                                                                             |
| Subagents (parentToolUseId nesting; no native negotiation for Codex, Gemini) | 5, 6, 7                                                                                                                                                                                                                                                                                                                                                                       |
| Usage (tokens + cost by engine, budgets on cost-reporting engines)           | 3, 9                                                                                                                                                                                                                                                                                                                                                                          |
| Commands                                                                     | 5, 8, 9                                                                                                                                                                                                                                                                                                                                                                       |
| Model (catalog, `default`, fixed-at-launch for Gemini)                       | 4, 8, 10                                                                                                                                                                                                                                                                                                                                                                      |
| Errors (`auth_required` wording)                                             | Plan 2 renders it; the server already records the exit/status rows. The `auth_required` session-failure detection is a small addition to Task 5 if the live smoke shows the adapters surface it as a JSON-RPC error rather than assistant text: catch it in `prompt()` and append a `status` row with `HARNESS_ENGINES[engine].loginCommand`. Tracked in plan 3's live smoke. |
| Migrations                                                                   | 2                                                                                                                                                                                                                                                                                                                                                                             |
| Configuration                                                                | 10                                                                                                                                                                                                                                                                                                                                                                            |
| Tests (server)                                                               | every task                                                                                                                                                                                                                                                                                                                                                                    |
| What changes on the branch (delete list)                                     | 9, 11                                                                                                                                                                                                                                                                                                                                                                         |

Placeholder scan: no TBD/TODO; every code step shows the code. Type consistency: `EngineSpec`, `EngineBins`, `DriverLaunch.systemPromptAppend`, `HarnessSupervisor.getCommands`, `HarnessCommand`, `HarnessPlanEntry`, `TurnSourceRow.key`, `loadUsageReport(db, budgets, now)` are named identically in every task that uses them.
