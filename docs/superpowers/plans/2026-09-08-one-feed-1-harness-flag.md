# One feed, plan 1 of 4: the Dispatch Harness flag

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Dispatch Harness its own server-owned on/off setting, so `dispatch` stops being a member of the enabled-agent-types list and is offered from exactly one place.

**Architecture:** A new `dispatch_harness_enabled` key in the existing `settings` key/value table, exposed as `GET`/`POST /api/v1/app/settings/dispatch-harness` the way the chat-surface flag already is. `dispatch` is dropped from `enabled_agent_types` on read and on write, and the agent-types POST answers `400` when a body names it. Every server gate that decides whether an agent type may be created or discovered reads a new `getOfferedAgentTypes(pool)` (enabled types plus `dispatch` iff the flag is on) instead of `getEnabledAgentTypes(pool)`. On the web the same distinction becomes two fields on the dashboard context: `enabledAgentTypes` (persisted, what the Settings card edits) and `offeredAgentTypes` (what the create dialog, jobs, templates and reviewer pickers offer).

**Tech Stack:** Fastify, Postgres via `pg`, Vitest (server, DB-backed through `scripts/server-tests-isolated.sh`), React 18 + TanStack Query + Jotai + shadcn/ui (web), Vitest + Testing Library under jsdom (web), Playwright (e2e).

## Global Constraints

- American spelling. No em-dashes anywhere: prose, comments, UI copy, commit messages.
- Engine names come from `HARNESS_ENGINES[i].label`. Nothing mentions the harness's earlier child process by name, DeepSeek, or "provider key".
- Prefer shadcn/ui primitives over hand-rolled UI. State stays colocated; React Query for server state; Jotai only for the persisted flag hint atoms that already follow that pattern.
- Motion inside a turn uses tokens from the harness `motion.ts`; the entry's arrival uses Brad's `animate-chat-enter`; reduced motion drops both (`useReducedMotion`, `motion-reduce:animate-none`). Nothing in this plan adds motion.
- Commit messages: `type(scope): imperative subject`, lowercase after the colon, body wrapped at 72 that leads with the failure mode or effect, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Scopes in use: `server`, `web`, `shared`, `e2e`, `docs`.
- Each task ends green: `pnpm run check` passes from the worktree root and the task's own tests pass. Tests use the existing fixtures; a test that asserts nothing is a defect.
- `dispatch` is never a member of the persisted `enabled_agent_types` list. There is no migration and no data rewrite: reads sanitize, writes sanitize, and the agent-types POST refuses a body naming it.
- The flag gates creation and discovery only. Turning it off never stops a running dispatch agent and never stops `/api/v1/agents/:id/harness/*` from serving one.
- Nothing in this plan touches turn entries, the chat feed, `HarnessPane`, `ChatPane`, `agentSupportsHarness`, `harnessEnabled`, or pane routing. Those are plans 2 to 4.
- Worktree `/home/nii/.dispatch/server-dsh-harness`, branch `dsh-harness-deploy`. Never touch `/home/nii/.dispatch/server` or `127.0.0.1:6767`. Do not run dev servers.

### Commands

| Purpose                              | Command                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Type check (the gate for every task) | `cd /home/nii/.dispatch/server-dsh-harness && pnpm run check`                                                            |
| Server tests, one or more files      | `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run <files>`       |
| Web tests, one or more files         | `cd /home/nii/.dispatch/server-dsh-harness/apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run <files>` |
| Web production gate                  | `cd /home/nii/.dispatch/server-dsh-harness && pnpm run finalize:web`                                                     |
| Full e2e suite                       | `cd /home/nii/.dispatch/server-dsh-harness && pnpm run test:e2e`                                                         |
| One e2e spec                         | `cd /home/nii/.dispatch/server-dsh-harness && bash scripts/e2e-isolated.sh e2e/<spec>`                                   |
| The live harness e2e spec            | `cd /home/nii/.dispatch/server-dsh-harness && pnpm run test:e2e:live`                                                    |

Two facts about the gates that change how you work:

- `apps/server/tsconfig.json` has `"include": ["src/**/*.ts", "src/**/*.js"]`, so **server test files are not type-checked by `pnpm run check`**. A wrong type in `apps/server/test/**` only shows up when vitest runs the file. Always run the server tests a task touches.
- `apps/web/tsconfig.json` has `"include": ["src"]`, and web tests live under `src`, so web test files **are** type-checked.

---

## File structure

| Path                                                        | Responsibility after this plan                                                                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/dispatch-harness-settings.ts`              | **New.** `isDispatchHarnessEnabled(pool)`, `setDispatchHarnessEnabled(pool, enabled)` over the `dispatch_harness_enabled` settings key. |
| `apps/server/src/routes/system.ts`                          | Adds `GET`/`POST /api/v1/app/settings/dispatch-harness`; the agent-types POST answers `400` when a body names `dispatch`.               |
| `apps/server/src/shared/agent-types.ts`                     | `sanitizeEnabledAgentTypes` drops `dispatch`.                                                                                           |
| `packages/shared/src/agent-types.ts`                        | The `DEFAULT_ENABLED_AGENT_TYPES` comment points at the flag.                                                                           |
| `apps/server/src/agent-type-settings.ts`                    | Adds `getOfferedAgentTypes(pool)`; re-exports it.                                                                                       |
| `apps/server/src/routes/agents/crud-routes.ts`              | The create gate reads the offered list.                                                                                                 |
| `apps/server/src/routes/agents/lifecycle-routes.ts`         | The reviewer-type gate reads the offered list.                                                                                          |
| `apps/server/src/server/mcp-handlers.ts`                    | `dispatch_launch_agent` reads the offered list.                                                                                         |
| `apps/server/src/server/mcp-review-handlers.ts`             | Persona launches read the offered list.                                                                                                 |
| `apps/server/src/routes/plugin.ts`                          | Both plugin gates read the offered list.                                                                                                |
| `apps/server/src/routes/release.ts`                         | The assisted-update driver picker reads the offered list, keeping its `dispatch` exclusion.                                             |
| `apps/web/src/hooks/use-server-flag.ts`                     | Gains `useServerFlagSetting(endpoint, hintAtom, messages)` and the `ServerFlagSetting` type.                                            |
| `apps/web/src/hooks/use-chat-surface-enabled.ts`            | Becomes two thin wrappers over `use-server-flag.ts`.                                                                                    |
| `apps/web/src/hooks/use-dispatch-harness-enabled.ts`        | **New.** `useDispatchHarnessEnabled()`, `useDispatchHarnessSetting()`, `DISPATCH_HARNESS_ENDPOINT`.                                     |
| `apps/web/src/lib/store.ts`                                 | Adds `dispatchHarnessEnabledHintAtom`.                                                                                                  |
| `apps/web/src/components/app/dispatch-harness-settings.tsx` | **New.** The `DispatchHarnessSettings` card.                                                                                            |
| `apps/web/src/components/app/settings-pane.tsx`             | Mounts the card next to the chat-surface card.                                                                                          |
| `apps/web/src/components/app/agent-type-settings.tsx`       | Stops offering `dispatch`; its description moves to the new card.                                                                       |
| `apps/web/src/lib/agent-types.ts`                           | Adds `offeredAgentTypes(enabled, dispatchHarnessEnabled)`; re-exports `DEFAULT_ENABLED_AGENT_TYPES`.                                    |
| `apps/web/src/components/app/dashboard-context.ts`          | Adds `offeredAgentTypes` beside `enabledAgentTypes`.                                                                                    |
| `apps/web/src/App.tsx`                                      | Derives the offered list from the flag and puts it on the context.                                                                      |
| `apps/web/src/layouts/dashboard-sections.tsx`               | Hands the offered list to the agents and automations routes, the persisted list to Settings.                                            |
| `e2e/helpers.ts`                                            | Adds `setDispatchHarnessViaAPI(request, enabled)`.                                                                                      |
| `e2e/harness-agent.spec.ts`                                 | Its four setups turn the harness on through the new endpoint.                                                                           |
| `e2e/settings.spec.ts`                                      | Covers the new toggle and the absent `dispatch` row.                                                                                    |
| `playwright.config.ts`                                      | Its serial-list comment names the harness flag.                                                                                         |

### New and changed test files

| Path                                                             | Covers                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/server/test/dispatch-harness-settings.test.ts`             | **New.** The flag module, and `getOfferedAgentTypes` with the flag on and off. |
| `apps/server/test/system-routes.test.ts`                         | The two flag routes; the agent-types `400`.                                    |
| `apps/server/test/agent-type-settings.test.ts`                   | `sanitizeEnabledAgentTypes` drops `dispatch`.                                  |
| `apps/server/test/agents-routes.test.ts`                         | Create and reviewer-type gates keyed off the flag, not the list.               |
| `apps/server/test/mcp-handlers.test.ts`                          | Mocks and asserts `getOfferedAgentTypes`.                                      |
| `apps/server/test/mcp-review-handlers.test.ts`                   | Its `agent-type-settings.js` mock exports `getOfferedAgentTypes`.              |
| `apps/server/test/release-routes.test.ts`                        | The driver picker seeds the flag, not the list.                                |
| `apps/web/src/lib/agent-types.test.ts`                           | `sanitizeEnabledAgentTypes` drops `dispatch`; `offeredAgentTypes`.             |
| `apps/web/src/hooks/use-dispatch-harness-enabled.test.tsx`       | **New.** The hook pair over the new endpoint.                                  |
| `apps/web/src/components/app/dispatch-harness-settings.test.tsx` | **New.** The card writes through the query the routing reads.                  |
| `apps/web/src/components/app/agent-type-settings.test.tsx`       | **New.** No `dispatch` row.                                                    |
| `apps/web/src/components/app/settings-pane.test.tsx`             | The card's place in the Agents section.                                        |
| `apps/web/src/layouts/dashboard-sections.test.tsx`               | Which list reaches which route.                                                |

### Every reader of `enabled_agent_types` under `apps/server/src/`, and its decision

Found with `grep -rn "enabled_agent_types\|getEnabledAgentTypes\|setEnabledAgentTypes\|sanitizeEnabledAgentTypes\|DEFAULT_ENABLED_AGENT_TYPES" apps/server/src/`.

| Site                                                          | What it is                                                                         | Decision                                                                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `agent-type-settings.ts:22` `getEnabledAgentTypes`            | Reads and sanitizes the persisted list                                             | Unchanged, and stays the only reader of the key                                                                 |
| `agent-type-settings.ts:35` `setEnabledAgentTypes`            | Sanitizes and writes the persisted list                                            | Unchanged; sanitize now drops `dispatch`                                                                        |
| `shared/agent-types.ts:48` `sanitizeEnabledAgentTypes`        | The sanitizer                                                                      | **Changed:** drops `dispatch` (Task 2)                                                                          |
| `routes/system.ts:373` `GET /app/settings/agent-types`        | Serves the persisted list to the web                                               | Unchanged. The web derives the offered list from the flag, so this response never carries `dispatch`            |
| `routes/system.ts:377` `POST /app/settings/agent-types`       | Writes the persisted list                                                          | **Changed:** `400` when the body names `dispatch` (Task 2)                                                      |
| `routes/agents/crud-routes.ts:257`                            | Creation gate for `POST /api/v1/agents`                                            | **Changed:** offered list (Task 4)                                                                              |
| `routes/agents/lifecycle-routes.ts:45`                        | Gate for `PATCH /api/v1/agents/:id/review-agent-type`                              | **Changed:** offered list (Task 4). Not in the spec's list; see the note below                                  |
| `server/mcp-handlers.ts:577`                                  | Gate for `dispatch_launch_agent`                                                   | **Changed:** offered list (Task 5)                                                                              |
| `server/mcp-review-handlers.ts:504`                           | Gate for a persona launch                                                          | **Changed:** offered list (Task 5)                                                                              |
| `routes/plugin.ts:33`                                         | Which plugin agent types `GET /api/v1/plugin/status` reports                       | **Changed:** offered list (Task 6). Behavior is identical because `PLUGIN_AGENT_TYPES` is `["claude", "codex"]` |
| `routes/plugin.ts:56`                                         | Gate for `POST /api/v1/plugin/update`                                              | **Changed:** offered list (Task 6). Same, identical behavior                                                    |
| `routes/release.ts:718`                                       | Picks the CLI type that drives an assisted update                                  | **Changed:** offered list (Task 6), keeping the existing `type !== "dispatch"` exclusion exactly as it is       |
| `server.ts:96` `import { AGENT_TYPES, setEnabledAgentTypes }` | An import with no use anywhere in the file                                         | Unchanged. Out of scope; deleting it is unrelated cleanup                                                       |
| `db/migrate.ts:55`                                            | Prerelease carry-over that rewrites `"dsh"` to `"dispatch"` inside the stored JSON | Unchanged. See the data decision below                                                                          |

**Why `lifecycle-routes.ts:45` is in.** The spec's list of gates omits it, but it is the same kind of gate: it decides which CLI kind future review agents are created as. The web reviewer picker offers `enabledAgentTypes.filter(isCliAgentType)` (`apps/web/src/components/app/persona-launcher.tsx:52`), which after Task 10 is the offered list. Leaving this route on the enabled list would mean the picker offers `dispatch` while saving that choice answers `400`. It reads the offered list.

**The data decision: nothing writes the stale row back.** A prerelease database can hold `dispatch` inside the `enabled_agent_types` JSON, because `apps/server/src/db/migrate.ts:53-56` rewrites a prerelease `"dsh"` member to `"dispatch"` as part of its one-time carry-over (asserted by `apps/server/test/migrations-harness.test.ts:172-179`). Nothing rewrites it out, and nothing needs to:

- Every read goes through `sanitizeEnabledAgentTypes`, which drops the member, so it never reaches a gate, the API response, or the web.
- `setEnabledAgentTypes` sanitizes on write, so the first Settings toggle after the upgrade removes it from the row for good.
- The spec says "No migration", and the `migrate.ts` carry-over is the wrong place anyway: it runs only when prerelease bookkeeping rows were just deleted, which happens at most once per database and may already have happened.
- A stale row that held only `dispatch` sanitizes to `DEFAULT_ENABLED_AGENT_TYPES`, which is the existing fallback for any list with no valid member. That install gains the CLI types back, which is correct: at least one type has to remain enabled.

Task 3 pins this with a test that seeds a stale row and asserts the read.

### Every web site that derives `dispatch` from the enabled types, and its decision

Found with `grep -rn '"dispatch"' apps/web/src/` and `grep -rn "enabledAgentTypes" apps/web/src/`.

| Site                                                                                                                            | What it is                                                                                          | Decision                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `App.tsx:70` `useState<AgentType[]>([...AGENT_TYPES])`                                                                          | The pre-fetch guess, which includes `dispatch` today                                                | **Changed:** seeds `DEFAULT_ENABLED_AGENT_TYPES` (Task 10) |
| `App.tsx:98-106`                                                                                                                | Fetches `/app/settings/agent-types` into that state                                                 | Unchanged. The response no longer carries `dispatch`       |
| `App.tsx:175` the context object                                                                                                | Hands one list to every route                                                                       | **Changed:** adds `offeredAgentTypes` (Task 10)            |
| `dashboard-sections.tsx:120` `AgentsRoute`                                                                                      | Feeds the create dialog, the sidebar picker, the persona launcher, agent-card actions               | **Changed:** offered list (Task 10)                        |
| `dashboard-sections.tsx:140`, `:149`, `:157` `AutomationsRoute`                                                                 | Feeds jobs and templates, including `JobsProvider` mounted at `automations-pane.tsx:323` and `:364` | **Changed:** offered list (Task 10)                        |
| `dashboard-sections.tsx:212` `SettingsRoute`                                                                                    | Feeds `AgentTypeSettings`                                                                           | Unchanged: the persisted list is what that card edits      |
| `agent-type-settings.tsx:16-24` `AGENT_TYPE_DESCRIPTIONS`                                                                       | Has a `dispatch` entry                                                                              | **Changed:** the entry moves to the new card (Task 9)      |
| `agent-type-settings.tsx:163` `CLI_AGENT_TYPES.map`                                                                             | Renders one checkbox per CLI type                                                                   | **Changed:** skips `dispatch` (Task 9)                     |
| `lib/agent-types.ts:19` re-export of `sanitizeEnabledAgentTypes`                                                                | The same server function                                                                            | Unchanged file, changed behavior (Task 2)                  |
| `create-agent-dialog.tsx:73-81` `["codex","claude","cursor","dispatch"]`                                                        | Which types show a model select                                                                     | Unchanged: not an offered-types list                       |
| `use-create-agent-form.ts:233` `createType === "dispatch"`                                                                      | Forces full access for a harness agent                                                              | Unchanged                                                  |
| `automations-form-fields.tsx:252`, `jobs-settings-tab.tsx:252`, `jobs-add-dialog.tsx:375` `alwaysOn={agentType === "dispatch"}` | Full-access display for a chosen type                                                               | Unchanged                                                  |
| `agent-card-details.tsx:104`, `persona-launcher.tsx:81`, `agent-type-icon.tsx:36-93`                                            | Render an existing agent's type                                                                     | Unchanged                                                  |
| `center-tabs.ts:95` `agentSupportsHarness`                                                                                      | Pane routing                                                                                        | Unchanged here. Plan 4 deletes it                          |
| `agents-view.tsx:250` `focusedAgent.type === "dispatch"`                                                                        | Forces the Agent pane for a running dispatch agent                                                  | Unchanged here. Plan 4 owns it                             |

Leaf components keep their prop name `enabledAgentTypes` even where they now receive the offered list. Renaming the prop would touch about fifteen components and their tests for no behavior change; the context field carries the distinction, and each of the three read sites in `dashboard-sections.tsx` gets a one-line comment saying which list it hands over.

---

## Task 1: The Dispatch Harness flag, its module and its two routes

**Files:**

- Create: `apps/server/src/dispatch-harness-settings.ts`
- Modify: `apps/server/src/routes/system.ts` (imports near line 22; new routes after line 485)
- Create: `apps/server/test/dispatch-harness-settings.test.ts`
- Modify: `apps/server/test/system-routes.test.ts` (new describe after line 658)

**Interfaces:**

- Consumes: `getSetting(pool, key): Promise<string | null>` and `setSetting(pool, key, value): Promise<void>` from `apps/server/src/db/settings.ts`.
- Produces: `isDispatchHarnessEnabled(pool: Pool): Promise<boolean>` and `setDispatchHarnessEnabled(pool: Pool, enabled: boolean): Promise<void>`, both from `apps/server/src/dispatch-harness-settings.js`. Routes `GET /api/v1/app/settings/dispatch-harness` returning `{ enabled: boolean }` and `POST /api/v1/app/settings/dispatch-harness` taking `{ enabled: boolean }`, returning `{ enabled: boolean }`, answering `400 { error: "enabled must be a boolean." }` otherwise.

- [ ] **Step 1: Write the failing module test**

Create `apps/server/test/dispatch-harness-settings.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  isDispatchHarnessEnabled,
  setDispatchHarnessEnabled,
} from "../src/dispatch-harness-settings.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await pool.query(
    "DELETE FROM settings WHERE key = 'dispatch_harness_enabled'"
  );
});

describe("the Dispatch Harness flag", () => {
  it("reads false on an install that has never set it", async () => {
    expect(await isDispatchHarnessEnabled(pool)).toBe(false);
  });

  it("round trips true, then back to false", async () => {
    await setDispatchHarnessEnabled(pool, true);
    expect(await isDispatchHarnessEnabled(pool)).toBe(true);

    await setDispatchHarnessEnabled(pool, false);
    expect(await isDispatchHarnessEnabled(pool)).toBe(false);
  });

  // The column is text, so anything could be in there. Only the exact
  // string the setter writes counts as on.
  it("reads false for a stored value that is not the string true", async () => {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('dispatch_harness_enabled', 'yes')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    );
    expect(await isDispatchHarnessEnabled(pool)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run test/dispatch-harness-settings.test.ts`

Expected: FAIL at collection with `Failed to load ../src/dispatch-harness-settings.js` (the module does not exist yet).

- [ ] **Step 3: Write the module**

Create `apps/server/src/dispatch-harness-settings.ts`:

```ts
import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";

/**
 * Whether the Dispatch Harness agent type (`dispatch`) is offered anywhere:
 * the create dialog, the sidebar picker, jobs, templates, reviewer pickers,
 * `dispatch_launch_agent` and persona launches. Off by default, because the
 * harness needs an engine's CLI installed and logged in on the server, and a
 * curious click without either should not be the first thing a new install
 * sees.
 *
 * This is the one switch. `dispatch` is deliberately not a member of
 * `enabled_agent_types` (see `sanitizeEnabledAgentTypes`), so there is no
 * second place to turn the harness on and no way for the two to disagree.
 *
 * The flag gates creation and discovery only. Turning it off leaves running
 * dispatch agents running, and `/api/v1/agents/:id/harness/*` keeps serving
 * them.
 *
 * `settings` is a key/value table read through `getSetting`/`setSetting`, so
 * an install with no row reads false and no migration is needed. Read per
 * settings request and per creation attempt; the lookup is one small indexed
 * query beside work that already costs more.
 */
const DISPATCH_HARNESS_KEY = "dispatch_harness_enabled";

export async function isDispatchHarnessEnabled(pool: Pool): Promise<boolean> {
  return (await getSetting(pool, DISPATCH_HARNESS_KEY)) === "true";
}

export async function setDispatchHarnessEnabled(
  pool: Pool,
  enabled: boolean
): Promise<void> {
  await setSetting(pool, DISPATCH_HARNESS_KEY, enabled ? "true" : "false");
}
```

- [ ] **Step 4: Run the module test to verify it passes**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run test/dispatch-harness-settings.test.ts`

Expected: PASS, 3 passed.

- [ ] **Step 5: Write the failing route tests**

In `apps/server/test/system-routes.test.ts`, insert this describe between line 658 (the closing `});` of `describe("POST /api/v1/app/settings/agent-types", ...)`) and line 660 (`describe("GET /api/v1/app/settings/ides", ...)`):

```ts
describe("/api/v1/app/settings/dispatch-harness", () => {
  // Order-independent: other tests in this file persist settings rows, and
  // this one owns its key.
  beforeEach(async () => {
    await ctx.pool.query(
      "DELETE FROM settings WHERE key = 'dispatch_harness_enabled'"
    );
  });

  it("reads false before anyone has set it", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/app/settings/dispatch-harness",
      headers: { cookie: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
  });

  it("round trips a POST through the GET", async () => {
    const post = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/dispatch-harness",
      headers: { cookie: sessionCookie },
      payload: { enabled: true },
    });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toEqual({ enabled: true });

    const get = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/app/settings/dispatch-harness",
      headers: { cookie: sessionCookie },
    });
    expect(get.json()).toEqual({ enabled: true });
  });

  it("turns the flag back off", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/dispatch-harness",
      headers: { cookie: sessionCookie },
      payload: { enabled: true },
    });
    const off = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/dispatch-harness",
      headers: { cookie: sessionCookie },
      payload: { enabled: false },
    });
    expect(off.json()).toEqual({ enabled: false });
  });

  it("rejects a non-boolean enabled", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/dispatch-harness",
      headers: { cookie: sessionCookie },
      payload: { enabled: "true" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("enabled must be a boolean.");
  });

  it("rejects a body with no enabled at all", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/app/settings/dispatch-harness",
      headers: { cookie: sessionCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 6: Run the route tests to verify they fail**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run test/system-routes.test.ts`

Expected: FAIL, 5 failed in the new describe, all with `expect(received).toBe(200)` receiving `404` (the route is not registered yet).

- [ ] **Step 7: Register the routes**

In `apps/server/src/routes/system.ts`, add this import immediately after the existing chat-surface import block (which sits at lines 22-25 and ends with `} from "../chat-surface-settings.js";`):

```ts
import {
  isDispatchHarnessEnabled,
  setDispatchHarnessEnabled,
} from "../dispatch-harness-settings.js";
```

Then, immediately after the chat-surface POST handler's closing `});` (line 485) and before the blank line preceding `app.get("/api/v1/app/settings/launch-guidance-trim", ...)`, add:

```ts
// The Dispatch Harness agent type's one switch. Kept beside the
// chat-surface flag because it is the same shape: server-owned boolean,
// GET on mount, POST on an explicit toggle. `dispatch` is never a member
// of `enabled_agent_types`, so this is the only way to turn it on.
app.get("/api/v1/app/settings/dispatch-harness", async () => {
  return { enabled: await isDispatchHarnessEnabled(deps.pool) };
});

app.post("/api/v1/app/settings/dispatch-harness", async (request, reply) => {
  const body = request.body as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return reply.code(400).send({ error: "enabled must be a boolean." });
  }
  await setDispatchHarnessEnabled(deps.pool, body.enabled);
  return { enabled: body.enabled };
});
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run test/dispatch-harness-settings.test.ts test/system-routes.test.ts`

Expected: PASS, 0 failed.

- [ ] **Step 9: Type check**

Run: `cd /home/nii/.dispatch/server-dsh-harness && pnpm run check`

Expected: exit 0, no `error TS` lines.

- [ ] **Step 10: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/server/src/dispatch-harness-settings.ts apps/server/src/routes/system.ts apps/server/test/dispatch-harness-settings.test.ts apps/server/test/system-routes.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add the dispatch harness settings flag

The harness agent type had no switch of its own: it rode inside
enabled_agent_types, where a checkbox could enable a type whose engine
CLI is not installed on this server. Add dispatch_harness_enabled with
the same shape as the chat-surface flag, defaulting to off, so the
harness has one place to be turned on.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `dispatch` is never a member of `enabled_agent_types`

**Files:**

- Modify: `apps/server/src/shared/agent-types.ts:48-57`
- Modify: `packages/shared/src/agent-types.ts:32-34` (comment only)
- Modify: `apps/server/src/routes/system.ts` (the agent-types POST, lines 377-408)
- Modify: `apps/server/test/agent-type-settings.test.ts:27-33`
- Modify: `apps/server/test/system-routes.test.ts` (the `POST /api/v1/app/settings/agent-types` describe)
- Modify: `apps/web/src/lib/agent-types.test.ts:117-119`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `sanitizeEnabledAgentTypes(value: unknown): AgentType[]` never returns a list containing `"dispatch"`. `POST /api/v1/app/settings/agent-types` answers `400` with `{ error: "dispatch is not set here. Turn the Dispatch Harness on or off at POST /api/v1/app/settings/dispatch-harness." }` when the request body's `enabledAgentTypes` contains `"dispatch"`.

- [ ] **Step 1: Write the failing sanitize tests**

In `apps/server/test/agent-type-settings.test.ts`, replace the whole final case (lines 27-33, `it("keeps the harness opt-in but accepts it when chosen", ...)`) with:

```ts
// The Dispatch Harness has its own setting (`dispatch_harness_enabled`), so
// this list is not where it is turned on. A prerelease database can still
// hold it inside the stored JSON; dropping it on read is what keeps every
// reader on one source for the harness.
it("drops the harness from a list that names it", () => {
  expect(DEFAULT_ENABLED_AGENT_TYPES).not.toContain("dispatch");
  expect(sanitizeEnabledAgentTypes(["dispatch", "claude"])).toEqual(["claude"]);
});

it("falls back to the defaults for a list that names only the harness", () => {
  expect(sanitizeEnabledAgentTypes(["dispatch"])).toEqual(
    DEFAULT_ENABLED_AGENT_TYPES
  );
});
```

In `apps/web/src/lib/agent-types.test.ts`, replace the case at lines 117-119 (`it("keeps the harness when it was chosen explicitly", ...)`) with:

```ts
// The Dispatch Harness has its own server setting, so it is never a member
// of this list. A list that names only the harness has no valid member left
// and falls back to the defaults.
it("drops the harness from a list that names it", () => {
  expect(sanitizeEnabledAgentTypes(["dispatch", "claude"])).toEqual(["claude"]);
  expect(sanitizeEnabledAgentTypes(["dispatch"])).toEqual(defaults);
});
```

- [ ] **Step 2: Write the failing route test**

In `apps/server/test/system-routes.test.ts`, inside `describe("POST /api/v1/app/settings/agent-types", ...)`, add this case immediately after `it("accepts valid agent types", ...)` (which ends at line 637):

```ts
// A body naming the harness used to be accepted and then silently
// sanitized away, so a stale caller looked like it had worked. Say no,
// and say where the switch actually is.
it("rejects a body that names the harness, pointing at its own endpoint", async () => {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/app/settings/agent-types",
    headers: { cookie: sessionCookie },
    payload: { enabledAgentTypes: ["claude", "dispatch"] },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe(
    "dispatch is not set here. Turn the Dispatch Harness on or off at POST /api/v1/app/settings/dispatch-harness."
  );
});
```

- [ ] **Step 3: Run all three test files to verify they fail**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run test/agent-type-settings.test.ts test/system-routes.test.ts`

Expected: FAIL. `drops the harness from a list that names it` fails with received `["dispatch", "claude"]`; `falls back to the defaults for a list that names only the harness` fails with received `["dispatch"]`; `rejects a body that names the harness` fails with received status `200`.

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/lib/agent-types.test.ts`

Expected: FAIL, `drops the harness from a list that names it` with received `["dispatch", "claude"]`.

- [ ] **Step 4: Change the sanitizer**

In `apps/server/src/shared/agent-types.ts`, replace the whole `sanitizeEnabledAgentTypes` function (lines 48-57) with:

```ts
/**
 * The persisted enabled-types list, cleaned up on read and on write.
 *
 * `dispatch` is never a member. The Dispatch Harness has its own setting
 * (`dispatch_harness_enabled`, see `dispatch-harness-settings.ts`) and
 * `getOfferedAgentTypes` is what adds it back for the gates, so this list
 * cannot be a second place the harness is turned on. A prerelease database
 * can still hold it inside the stored JSON, which is why this drops it
 * rather than trusting the writers.
 */
export function sanitizeEnabledAgentTypes(value: unknown): AgentType[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_ENABLED_AGENT_TYPES];
  }

  const unique = value
    .filter(isAgentType)
    .filter((type) => type !== "dispatch")
    .filter((type, index, types) => types.indexOf(type) === index);
  return unique.length > 0 ? unique : [...DEFAULT_ENABLED_AGENT_TYPES];
}
```

- [ ] **Step 5: Move the comment on the defaults onto the flag**

In `packages/shared/src/agent-types.ts`, replace the comment at lines 32-34 (the three lines starting `// What an install offers before anyone saves a choice.`) with:

```ts
// What an install offers before anyone saves a choice. `dispatch` is absent
// because the Dispatch Harness is not set here at all: it has its own
// server setting (`dispatch_harness_enabled`), and `sanitizeEnabledAgentTypes`
// drops it from this list on read and on write.
```

- [ ] **Step 6: Reject a body that names the harness**

In `apps/server/src/routes/system.ts`, inside the `POST /api/v1/app/settings/agent-types` handler, add this block immediately after the `!Array.isArray(body?.enabledAgentTypes)` guard (which closes with `}` on line 383) and before the blank line preceding `const uniqueTypes = ...`:

```ts
// `dispatch` is a member of AGENT_TYPES, so without this the body would
// pass validation and then be sanitized away, answering 200 with a list
// that silently lacks what was asked for.
if (body.enabledAgentTypes.includes("dispatch")) {
  return reply.code(400).send({
    error:
      "dispatch is not set here. Turn the Dispatch Harness on or off at POST /api/v1/app/settings/dispatch-harness.",
  });
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run test/agent-type-settings.test.ts test/system-routes.test.ts`

Expected: PASS, 0 failed.

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/lib/agent-types.test.ts`

Expected: PASS, 0 failed.

- [ ] **Step 8: Type check**

Run: `cd /home/nii/.dispatch/server-dsh-harness && pnpm run check`

Expected: exit 0, no `error TS` lines.

- [ ] **Step 9: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/server/src/shared/agent-types.ts apps/server/src/routes/system.ts packages/shared/src/agent-types.ts apps/server/test/agent-type-settings.test.ts apps/server/test/system-routes.test.ts apps/web/src/lib/agent-types.test.ts
git commit -m "$(cat <<'EOF'
feat(server): keep dispatch out of the enabled agent types

Enabling the harness through the agent-types list gave it two switches
that could disagree, and a POST naming it answered 200 with a list that
had quietly dropped it. Sanitize it out on read and on write, and answer
400 naming the harness endpoint instead.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `getOfferedAgentTypes`

**Files:**

- Modify: `apps/server/src/agent-type-settings.ts`
- Modify: `apps/server/test/dispatch-harness-settings.test.ts` (append a describe)

**Interfaces:**

- Consumes: `isDispatchHarnessEnabled(pool: Pool): Promise<boolean>` and `setDispatchHarnessEnabled(pool: Pool, enabled: boolean): Promise<void>` from `apps/server/src/dispatch-harness-settings.js` (Task 1). `getEnabledAgentTypes(pool: Pool): Promise<AgentType[]>` from `apps/server/src/agent-type-settings.js`, which after Task 2 never returns `"dispatch"`.
- Produces: `getOfferedAgentTypes(pool: Pool): Promise<AgentType[]>` from `apps/server/src/agent-type-settings.js`.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/dispatch-harness-settings.test.ts`. Extend its import block to:

```ts
import {
  DEFAULT_ENABLED_AGENT_TYPES,
  getOfferedAgentTypes,
} from "../src/agent-type-settings.js";
import {
  isDispatchHarnessEnabled,
  setDispatchHarnessEnabled,
} from "../src/dispatch-harness-settings.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";
```

Extend its `beforeEach` to clear both keys:

```ts
beforeEach(async () => {
  await pool.query(
    "DELETE FROM settings WHERE key IN ('dispatch_harness_enabled', 'enabled_agent_types')"
  );
});
```

Then append this describe at the end of the file:

```ts
/** Write the persisted enabled-types row directly, bypassing the sanitizer. */
async function seedEnabledAgentTypes(types: string[]): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('enabled_agent_types', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(types)]
  );
}

describe("getOfferedAgentTypes", () => {
  it("is the enabled types with the flag off", async () => {
    await seedEnabledAgentTypes(["claude", "codex"]);
    expect(await getOfferedAgentTypes(pool)).toEqual(["claude", "codex"]);
  });

  it("adds the harness with the flag on", async () => {
    await seedEnabledAgentTypes(["claude", "codex"]);
    await setDispatchHarnessEnabled(pool, true);
    expect(await getOfferedAgentTypes(pool)).toEqual([
      "claude",
      "codex",
      "dispatch",
    ]);
  });

  it("drops the harness again when the flag goes off", async () => {
    await seedEnabledAgentTypes(["claude"]);
    await setDispatchHarnessEnabled(pool, true);
    await setDispatchHarnessEnabled(pool, false);
    expect(await getOfferedAgentTypes(pool)).toEqual(["claude"]);
  });

  it("offers the harness on an install that never saved a type choice", async () => {
    await setDispatchHarnessEnabled(pool, true);
    expect(await getOfferedAgentTypes(pool)).toEqual([
      ...DEFAULT_ENABLED_AGENT_TYPES,
      "dispatch",
    ]);
  });

  // A prerelease database carries `dispatch` inside the stored JSON (see
  // db/migrate.ts's one-time rename). Nothing rewrites the row, so the read
  // has to be what keeps the flag the only source, with no duplicate member
  // when the flag is on.
  it("never doubles the harness from a stale persisted row", async () => {
    await seedEnabledAgentTypes(["claude", "dispatch", "terminal"]);
    expect(await getOfferedAgentTypes(pool)).toEqual(["claude", "terminal"]);

    await setDispatchHarnessEnabled(pool, true);
    expect(await getOfferedAgentTypes(pool)).toEqual([
      "claude",
      "terminal",
      "dispatch",
    ]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run test/dispatch-harness-settings.test.ts`

Expected: FAIL, 5 failed in the new describe with `getOfferedAgentTypes is not a function`.

- [ ] **Step 3: Add the function**

In `apps/server/src/agent-type-settings.ts`, add the flag import after the existing `./db/settings.js` import:

```ts
import { isDispatchHarnessEnabled } from "./dispatch-harness-settings.js";
```

Then append to the end of the file:

```ts
/**
 * What the app may create right now: the persisted enabled types plus
 * `dispatch` when and only when the Dispatch Harness flag is on.
 *
 * Every creation and discovery gate reads this, not `getEnabledAgentTypes`:
 * the create route, the reviewer-type route, `dispatch_launch_agent`, persona
 * launches, the plugin routes and the assisted-update driver picker. That is
 * what makes the harness's one switch reach all of them at once.
 *
 * No duplicate is possible: `sanitizeEnabledAgentTypes` drops `dispatch` from
 * the persisted list on every branch, so the append below is the only place
 * it can enter.
 */
export async function getOfferedAgentTypes(pool: Pool): Promise<AgentType[]> {
  const [enabled, harnessEnabled] = await Promise.all([
    getEnabledAgentTypes(pool),
    isDispatchHarnessEnabled(pool),
  ]);
  return harnessEnabled ? [...enabled, "dispatch"] : enabled;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run test/dispatch-harness-settings.test.ts`

Expected: PASS, 8 passed.

- [ ] **Step 5: Type check**

Run: `cd /home/nii/.dispatch/server-dsh-harness && pnpm run check`

Expected: exit 0, no `error TS` lines.

- [ ] **Step 6: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/server/src/agent-type-settings.ts apps/server/test/dispatch-harness-settings.test.ts
git commit -m "$(cat <<'EOF'
feat(server): add getOfferedAgentTypes

Gates that ask "may this type be created" have to consult two settings
now that the harness has its own flag, and asking each of them to do
that by hand is how the two lists drift apart. Fold both reads into one
function every gate can call.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: The create route and the reviewer-type route read the offered list

**Files:**

- Modify: `apps/server/src/routes/agents/crud-routes.ts:7-11` and `:257-262`
- Modify: `apps/server/src/routes/agents/lifecycle-routes.ts:3-6` and `:44-51`
- Modify: `apps/server/test/agents-routes.test.ts` (the `beforeEach` at lines 39-47, the two seeds at lines 125-130 and 142-147, plus four new cases)

**Interfaces:**

- Consumes: `getOfferedAgentTypes(pool: Pool): Promise<AgentType[]>` from `../../agent-type-settings.js` (Task 3).
- Produces: `POST /api/v1/agents` with `type: "dispatch"` answers `201` when `dispatch_harness_enabled` is `true` and `400 { error: "dispatch agents are disabled in settings." }` when it is not. Same for `PATCH /api/v1/agents/:id/review-agent-type` with `{ reviewAgentType: "dispatch" }`.

- [ ] **Step 1: Write the failing tests**

In `apps/server/test/agents-routes.test.ts`, first replace the settings cleanup inside the `beforeEach` (lines 44-46, the `await ctx.pool.query("DELETE FROM settings WHERE key = 'enabled_agent_types'");` call) with:

```ts
await ctx.pool.query(
  `DELETE FROM settings
      WHERE key IN ('enabled_agent_types', 'dispatch_harness_enabled')`
);
```

Next, add this helper immediately after the `createAgent` helper (which ends with its closing `}` on line 37) and before the `beforeEach`:

```ts
/** Turn the Dispatch Harness flag on for one test. */
async function enableDispatchHarness(): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO settings (key, value)
      VALUES ('dispatch_harness_enabled', 'true')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
  );
}
```

Now replace the seed inside `it("stores the default harness model for a dispatch agent created without one", ...)` (lines 125-130, the `await ctx.pool.query(...)` that inserts `JSON.stringify(["dispatch"])`) with:

```ts
await enableDispatchHarness();
```

And replace the seed inside `it("stores full access for a dispatch agent however it was asked for", ...)` (lines 142-147, the `await ctx.pool.query(...)` that inserts `JSON.stringify(["dispatch", "claude"])`) with:

```ts
await enableDispatchHarness();
```

Then add these two cases immediately after `it("rejects disabled agent type", ...)` (which ends at line 236):

```ts
// The harness is not a member of enabled_agent_types at all, so the create
// gate has to read the flag or a dispatch agent could never be created.
it("rejects a dispatch agent while the harness flag is off", async () => {
  const res = await authedInject("POST", "/api/v1/agents", {
    cwd: "/tmp",
    useWorktree: false,
    type: "dispatch",
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("dispatch agents are disabled in settings.");
});

it("accepts a dispatch agent once the harness flag is on", async () => {
  await enableDispatchHarness();
  const agent = await createAgent({ type: "dispatch" });
  expect(agent.type).toBe("dispatch");
});
```

And add these two cases immediately after `it("rejects disabled agent type for review", ...)` (which ends at line 637):

```ts
it("rejects the harness as a reviewer while its flag is off", async () => {
  const agent = await createAgent({ type: "claude" });
  const res = await authedInject(
    "PATCH",
    `/api/v1/agents/${agent.id}/review-agent-type`,
    { reviewAgentType: "dispatch" }
  );
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("dispatch agents are disabled in settings.");
});

// The reviewer picker offers whatever the create dialog offers, so a saved
// dispatch reviewer has to be accepted or the picker offers a choice the
// server refuses.
it("accepts the harness as a reviewer once its flag is on", async () => {
  await enableDispatchHarness();
  const agent = await createAgent({ type: "claude" });
  const res = await authedInject(
    "PATCH",
    `/api/v1/agents/${agent.id}/review-agent-type`,
    { reviewAgentType: "dispatch" }
  );
  expect(res.statusCode).toBe(200);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run test/agents-routes.test.ts`

Expected: FAIL, 6 failed. `stores the default harness model`, `stores full access for a dispatch agent`, `accepts a dispatch agent once the harness flag is on` and `accepts the harness as a reviewer once its flag is on` all fail because the create or patch call answers `400 dispatch agents are disabled in settings.`; the two "rejects ... while the flag is off" cases pass already.

- [ ] **Step 3: Point the create gate at the offered list**

In `apps/server/src/routes/agents/crud-routes.ts`, change the import block at lines 7-11 from:

```ts
import {
  AGENT_TYPES,
  type AgentType,
  getEnabledAgentTypes,
} from "../../agent-type-settings.js";
```

to:

```ts
import {
  AGENT_TYPES,
  type AgentType,
  getOfferedAgentTypes,
} from "../../agent-type-settings.js";
```

Then change lines 257-258 from:

```ts
    const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
    if (!enabledAgentTypes.includes(agentType)) {
```

to:

```ts
    // The offered list, not the enabled one: `dispatch` is never a member of
    // the persisted enabled types and arrives from the harness flag instead.
    const offeredAgentTypes = await getOfferedAgentTypes(deps.pool);
    if (!offeredAgentTypes.includes(agentType)) {
```

- [ ] **Step 4: Point the reviewer-type gate at the offered list**

In `apps/server/src/routes/agents/lifecycle-routes.ts`, change the import block at lines 3-6 from:

```ts
import {
  CLI_AGENT_TYPES,
  getEnabledAgentTypes,
} from "../../agent-type-settings.js";
```

to:

```ts
import {
  CLI_AGENT_TYPES,
  getOfferedAgentTypes,
} from "../../agent-type-settings.js";
```

Then change lines 44-51 from:

```ts
if (reviewAgentType) {
  const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
  if (!enabledAgentTypes.includes(reviewAgentType)) {
    return reply.code(400).send({
      error: `${reviewAgentType} agents are disabled in settings.`,
    });
  }
}
```

to:

```ts
if (reviewAgentType) {
  // The reviewer picker offers what the create dialog offers, so this
  // gate reads the same offered list: the enabled types plus `dispatch`
  // when the Dispatch Harness flag is on.
  const offeredAgentTypes = await getOfferedAgentTypes(deps.pool);
  if (!offeredAgentTypes.includes(reviewAgentType)) {
    return reply.code(400).send({
      error: `${reviewAgentType} agents are disabled in settings.`,
    });
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run test/agents-routes.test.ts`

Expected: PASS, 0 failed.

- [ ] **Step 6: Type check**

Run: `cd /home/nii/.dispatch/server-dsh-harness && pnpm run check`

Expected: exit 0, no `error TS` lines.

- [ ] **Step 7: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/server/src/routes/agents/crud-routes.ts apps/server/src/routes/agents/lifecycle-routes.ts apps/server/test/agents-routes.test.ts
git commit -m "$(cat <<'EOF'
fix(server): gate agent creation on the offered types

With dispatch out of enabled_agent_types, both the create route and the
reviewer-type route refused every dispatch agent, so the harness could
not be used at all. Read the offered list, which adds the type back
while its flag is on.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `dispatch_launch_agent` and persona launches read the offered list

**Files:**

- Modify: `apps/server/src/server/mcp-handlers.ts:13-16` and `:577-582`
- Modify: `apps/server/src/server/mcp-review-handlers.ts:7-11` and `:504-507`
- Modify: `apps/server/test/mcp-handlers.test.ts` (the module mock at lines 50-62, the import at line 142, and the six `vi.mocked(getEnabledAgentTypes)` calls at lines 976, 986, 1020, 1056, 1221 and 1458)
- Modify: `apps/server/test/mcp-review-handlers.test.ts:62-70` (the module mock)

**Interfaces:**

- Consumes: `getOfferedAgentTypes(pool: Pool): Promise<AgentType[]>` from `../agent-type-settings.js` (Task 3).
- Produces: `dispatch_launch_agent` and `launchPersona` throw `` `${agentType} agents are disabled in settings.` `` when the type is not in the offered list. No new exported names.

Both test files replace the whole `../src/agent-type-settings.js` module with `vi.mock`, so the factory has to export every name the module's importers use. Keep `getEnabledAgentTypes` in the factories alongside the new export: a missing export is a hard failure at import time, an extra one costs nothing.

- [ ] **Step 1: Update the two module mocks and switch the six overrides**

In `apps/server/test/mcp-handlers.test.ts`, replace the mock at lines 50-62 with:

```ts
vi.mock("../src/agent-type-settings.js", () => ({
  CLI_AGENT_TYPES: ["claude", "codex", "cursor", "opencode", "dispatch"],
  getEnabledAgentTypes: vi.fn(async () => [
    "claude",
    "codex",
    "cursor",
    "opencode",
  ]),
  getOfferedAgentTypes: vi.fn(async () => [
    "claude",
    "codex",
    "cursor",
    "opencode",
    "dispatch",
  ]),
  isCliAgentType: vi.fn((t: string) =>
    ["claude", "codex", "cursor", "opencode", "dispatch"].includes(t)
  ),
}));
```

Replace the import at line 142:

```ts
import { getOfferedAgentTypes } from "../src/agent-type-settings.js";
```

Then replace each of the six `vi.mocked(getEnabledAgentTypes)` calls with `vi.mocked(getOfferedAgentTypes)`, leaving every argument as it is. In order, they are:

- line 976, inside `it("throws when agent type is disabled", ...)`: `vi.mocked(getOfferedAgentTypes).mockResolvedValue([]);`
- line 986, inside `it("includes full-access arg for claude agents with fullAccess", ...)`: `vi.mocked(getOfferedAgentTypes).mockResolvedValue(["claude", "codex", "opencode"]);`
- line 1020, inside `it("includes full-access arg for codex agents with fullAccess", ...)`: same replacement.
- line 1056, inside `it("does not include full-access arg for opencode agents", ...)`: same replacement.
- line 1221, inside the harness-parent `beforeEach`: `vi.mocked(getOfferedAgentTypes).mockResolvedValue(["claude", "codex", "cursor", "opencode", "dispatch"] as never);`
- line 1458, inside `it("throws when agent type is disabled in settings", ...)`: `vi.mocked(getOfferedAgentTypes).mockResolvedValueOnce(["codex"] as any);`

In `apps/server/test/mcp-review-handlers.test.ts`, replace the mock at lines 62-70 with:

```ts
vi.mock("../src/agent-type-settings.js", () => ({
  CLI_AGENT_TYPES: ["claude", "codex", "opencode"],
  getEnabledAgentTypes: vi
    .fn()
    .mockResolvedValue(["claude", "codex", "opencode"]),
  getOfferedAgentTypes: vi
    .fn()
    .mockResolvedValue(["claude", "codex", "opencode"]),
  isCliAgentType: vi.fn((t: string) =>
    ["claude", "codex", "opencode"].includes(t)
  ),
}));
```

- [ ] **Step 2: Run both files to verify they fail**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run test/mcp-handlers.test.ts test/mcp-review-handlers.test.ts`

Expected: FAIL. The four cases that narrow the list (`throws when agent type is disabled`, the three full-access cases) and `throws when agent type is disabled in settings` now fail, because the handlers still read the unnarrowed `getEnabledAgentTypes` mock: the two "throws" cases fail with `promise resolved instead of rejecting`, the full-access cases fail on their `createAgent` argument assertions.

- [ ] **Step 3: Switch `dispatch_launch_agent`**

In `apps/server/src/server/mcp-handlers.ts`, change the import block at lines 13-16 from:

```ts
import {
  CLI_AGENT_TYPES,
  getEnabledAgentTypes,
} from "../agent-type-settings.js";
```

to:

```ts
import {
  CLI_AGENT_TYPES,
  getOfferedAgentTypes,
} from "../agent-type-settings.js";
```

Then change lines 577-582 from:

```ts
const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
if (
  !enabledAgentTypes.includes(agentType as (typeof CLI_AGENT_TYPES)[number])
) {
  throw new Error(`${agentType} agents are disabled in settings.`);
}
```

to:

```ts
// The offered list: the persisted enabled types plus `dispatch` when the
// Dispatch Harness flag is on. A parent may launch a harness child exactly
// when the create dialog would offer the type.
const offeredAgentTypes = await getOfferedAgentTypes(deps.pool);
if (
  !offeredAgentTypes.includes(agentType as (typeof CLI_AGENT_TYPES)[number])
) {
  throw new Error(`${agentType} agents are disabled in settings.`);
}
```

- [ ] **Step 4: Switch persona launches**

In `apps/server/src/server/mcp-review-handlers.ts`, change the import block at lines 7-11 from:

```ts
import {
  CLI_AGENT_TYPES,
  getEnabledAgentTypes,
  isCliAgentType,
} from "../agent-type-settings.js";
```

to:

```ts
import {
  CLI_AGENT_TYPES,
  getOfferedAgentTypes,
  isCliAgentType,
} from "../agent-type-settings.js";
```

Then change lines 504-507 from:

```ts
const enabledAgentTypes = await getEnabledAgentTypes(pool);
if (!enabledAgentTypes.includes(personaAgentType)) {
  throw new Error(`${personaAgentType} agents are disabled in settings.`);
}
```

to:

```ts
// A persona runs as its parent's kind by default, so a harness parent
// launches a harness persona. That needs the offered list, which adds
// `dispatch` while the Dispatch Harness flag is on.
const offeredAgentTypes = await getOfferedAgentTypes(pool);
if (!offeredAgentTypes.includes(personaAgentType)) {
  throw new Error(`${personaAgentType} agents are disabled in settings.`);
}
```

- [ ] **Step 5: Run both files to verify they pass**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run test/mcp-handlers.test.ts test/mcp-review-handlers.test.ts`

Expected: PASS, 0 failed.

- [ ] **Step 6: Type check**

Run: `cd /home/nii/.dispatch/server-dsh-harness && pnpm run check`

Expected: exit 0, no `error TS` lines.

- [ ] **Step 7: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/server/src/server/mcp-handlers.ts apps/server/src/server/mcp-review-handlers.ts apps/server/test/mcp-handlers.test.ts apps/server/test/mcp-review-handlers.test.ts
git commit -m "$(cat <<'EOF'
fix(server): gate agent and persona launches on the offered types

A harness agent could not launch a child or a persona of its own kind
once dispatch left enabled_agent_types, because both launch paths still
read that list. Read the offered list, so a harness parent works while
the flag is on.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: The plugin routes and the assisted-update picker read the offered list

**Files:**

- Modify: `apps/server/src/routes/plugin.ts:4`, `:33-35`, `:56-57`
- Modify: `apps/server/src/routes/release.ts:6-9` and `:718-721`
- Modify: `apps/server/test/release-routes.test.ts:501-507` and `:541-543`

**Interfaces:**

- Consumes: `getOfferedAgentTypes(pool: Pool): Promise<AgentType[]>` from `../agent-type-settings.js` (Task 3).
- Produces: no new exported names. `POST /api/v1/release/assisted/launch` still never picks `dispatch` as the driver.

The two plugin gates are behavior-identical either way, because `PLUGIN_AGENT_TYPES` is `["claude", "codex"]` and so `dispatch` can never reach them. They move anyway, so that "every gate reads the offered list" holds without exceptions a later reader has to check. The cost is one extra small settings read per plugin-status request.

- [ ] **Step 1: Write the failing release test**

In `apps/server/test/release-routes.test.ts`, inside `it("never picks a Dispatch Harness agent to drive the update", ...)`, replace lines 501-507 (the two comment lines starting `// The update restarts the service` and the `await ctx.pool.query(...)` inserting `JSON.stringify(["dispatch", "claude"])`) with:

```ts
// The update restarts the service that owns the harness child, so a
// dispatch agent has to be skipped even though the offered list carries
// it whenever the harness flag is on.
await ctx.pool.query(
  `INSERT INTO settings (key, value) VALUES ('enabled_agent_types', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  [JSON.stringify(["claude"])]
);
await ctx.pool.query(
  `INSERT INTO settings (key, value)
        VALUES ('dispatch_harness_enabled', 'true')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
);
```

And in the same test's `finally`, replace the cleanup at lines 541-543 (the `DELETE FROM settings WHERE key = 'enabled_agent_types'` query) with:

```ts
await ctx.pool.query(
  `DELETE FROM settings
          WHERE key IN ('enabled_agent_types', 'dispatch_harness_enabled')`
);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run test/release-routes.test.ts`

Expected: PASS. This seed change alone does not fail, because with `["claude"]` enabled the picker finds `claude` whether or not it sees the harness. The test is a regression guard for Step 4, not a red-first test: with the offered list in place and its `type !== "dispatch"` filter removed it would answer `dispatch`. Record the pass and continue.

- [ ] **Step 3: Switch the plugin routes**

In `apps/server/src/routes/plugin.ts`, change line 4 from:

```ts
import { getEnabledAgentTypes } from "../agent-type-settings.js";
```

to:

```ts
import { getOfferedAgentTypes } from "../agent-type-settings.js";
```

Change lines 33-35 from:

```ts
const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
const applicableTypes = PLUGIN_AGENT_TYPES.filter((type) =>
  enabledAgentTypes.includes(type)
);
```

to:

```ts
// The offered list, like every other gate. `PLUGIN_AGENT_TYPES` is claude
// and codex, so the harness can never be one of these either way; reading
// one list everywhere is what stops a later reader having to check which.
const offeredAgentTypes = await getOfferedAgentTypes(deps.pool);
const applicableTypes = PLUGIN_AGENT_TYPES.filter((type) =>
  offeredAgentTypes.includes(type)
);
```

Change lines 56-57 from:

```ts
    const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
    if (!enabledAgentTypes.includes(agentType)) {
```

to:

```ts
    const offeredAgentTypes = await getOfferedAgentTypes(deps.pool);
    if (!offeredAgentTypes.includes(agentType)) {
```

- [ ] **Step 4: Switch the assisted-update driver picker**

In `apps/server/src/routes/release.ts`, change the import block at lines 6-9 from:

```ts
import {
  getEnabledAgentTypes,
  isCliAgentType,
} from "../agent-type-settings.js";
```

to:

```ts
import {
  getOfferedAgentTypes,
  isCliAgentType,
} from "../agent-type-settings.js";
```

Then change lines 718-721 from:

```ts
const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
// A Dispatch Harness agent is never the driver: the update restarts the
// service that owns its engine child, which cuts the agent's own turn.
const assistedType = enabledAgentTypes.find(
  (type) => isCliAgentType(type) && type !== "dispatch"
);
```

to:

```ts
const offeredAgentTypes = await getOfferedAgentTypes(deps.pool);
// A Dispatch Harness agent is never the driver: the update restarts the
// service that owns its engine child, which cuts the agent's own turn. The
// exclusion stays even though the type now arrives from its own flag.
const assistedType = offeredAgentTypes.find(
  (type) => isCliAgentType(type) && type !== "dispatch"
);
```

- [ ] **Step 5: Run the release tests to verify they pass**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run test/release-routes.test.ts`

Expected: PASS, 0 failed. `never picks a Dispatch Harness agent to drive the update` still asserts `response.json().agent.type` is `"claude"`.

- [ ] **Step 6: Prove no reader of the enabled list is left in a gate**

Run: `cd /home/nii/.dispatch/server-dsh-harness && grep -rn "getEnabledAgentTypes" apps/server/src/`

Expected: exactly three lines, all in `apps/server/src/agent-type-settings.ts`: the function's own definition, its use inside `getOfferedAgentTypes`, and the sentence in that function's doc comment that names it. No line under `apps/server/src/routes/` or `apps/server/src/server/`.

- [ ] **Step 7: Type check and run the whole server suite**

Run: `cd /home/nii/.dispatch/server-dsh-harness && pnpm run check`

Expected: exit 0, no `error TS` lines.

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/server && bash ../../scripts/server-tests-isolated.sh run`

Expected: PASS, 0 failed. This is the point where every server change in this plan is in, so the whole suite is the gate.

- [ ] **Step 8: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/server/src/routes/plugin.ts apps/server/src/routes/release.ts apps/server/test/release-routes.test.ts
git commit -m "$(cat <<'EOF'
refactor(server): read the offered types in the last two gates

The plugin routes and the assisted-update driver picker were the only
gates left reading the enabled list, which is a difference a later
reader has to check for no reason. Point them at the offered list too,
keeping the picker's dispatch exclusion.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `useServerFlagSetting`, extracted from the chat-surface hook

**Files:**

- Modify: `apps/web/src/hooks/use-server-flag.ts`
- Modify: `apps/web/src/hooks/use-chat-surface-enabled.ts` (replaced almost entirely)
- Test: `apps/web/src/hooks/use-chat-surface-enabled.test.tsx` (unchanged, and the gate)

**Interfaces:**

- Consumes: `useServerFlag(endpoint, hintAtom)`, `serverFlagQueryKey(endpoint)`, `ServerFlagResponse`, `ServerFlagHintAtom`, all already in `apps/web/src/hooks/use-server-flag.ts`.
- Produces: `type ServerFlagSetting = { enabled: boolean; loaded: boolean; error: string; setEnabled: (next: boolean) => void }` and `useServerFlagSetting(endpoint: string, hintAtom: ServerFlagHintAtom, messages: { save: string; load: string }): ServerFlagSetting`, both from `@/hooks/use-server-flag`. `useChatSurfaceEnabled()` and `useChatSurfaceSetting()` keep their signatures; `ChatSurfaceSetting` becomes an alias of `ServerFlagSetting`.

The existing suite in `use-chat-surface-enabled.test.tsx` covers every branch of this state machine (the in-flight GET losing to a toggle, the rollback on a failed POST, the sequence guard on two quick flips). It is the regression gate for this extraction and must not be edited.

- [ ] **Step 1: Record the green baseline**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/hooks/use-chat-surface-enabled.test.tsx`

Expected: PASS, 8 passed. Write down the count: the same 8 must pass at the end without the file changing.

- [ ] **Step 2: Add the generic setting hook**

In `apps/web/src/hooks/use-server-flag.ts`, replace the first two import lines:

```ts
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
```

with:

```ts
import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
```

Then append to the end of the file:

```ts
export type ServerFlagSetting = {
  /** The confirmed value, or the optimistic one while a write is in flight. */
  enabled: boolean;
  /** False until either the fetch or a toggle has produced a value. */
  loaded: boolean;
  /** Empty string when there is nothing to report. */
  error: string;
  setEnabled: (next: boolean) => void;
};

/**
 * The settings-page toggle for a `useServerFlag` flag. One state machine over
 * the same query the flag reads: the GET is that query's own fetch, a toggle
 * writes the optimistic value straight into the cache and cancels any GET
 * still in flight (so a slow initial fetch cannot land after a successful
 * toggle and revert it), and a failed POST rolls the cache back to the last
 * confirmed value. Nothing here fetches on its own.
 *
 * Writes are sequence-guarded: only the newest toggle's outcome touches the
 * cache, so two quick flips cannot leave the UI on the older value.
 *
 * `messages.save` is shown when a POST fails without a message of its own;
 * `messages.load` when the initial GET failed and nothing has produced a
 * value yet.
 */
export function useServerFlagSetting(
  endpoint: string,
  hintAtom: ServerFlagHintAtom,
  messages: { save: string; load: string }
): ServerFlagSetting {
  const queryClient = useQueryClient();
  const { enabled, loaded } = useServerFlag(endpoint, hintAtom);
  const queryKey = serverFlagQueryKey(endpoint);
  const { isError: loadFailed } = useQuery<ServerFlagResponse>({
    queryKey,
    queryFn: () => api<ServerFlagResponse>(endpoint),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const latestWrite = useRef(0);

  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      api<ServerFlagResponse>(endpoint, {
        method: "POST",
        body: JSON.stringify({ enabled: next }),
      }),
    onMutate: async (next) => {
      const seq = (latestWrite.current += 1);
      // A GET still in flight would otherwise resolve after this toggle and
      // overwrite the optimistic value with the pre-toggle one.
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ServerFlagResponse>(queryKey);
      queryClient.setQueryData<ServerFlagResponse>(queryKey, {
        enabled: next,
      });
      return { seq, previous };
    },
    onSuccess: (data, _next, context) => {
      if (context?.seq !== latestWrite.current) return;
      queryClient.setQueryData<ServerFlagResponse>(queryKey, data);
    },
    onError: (_error, _next, context) => {
      if (context?.seq !== latestWrite.current) return;
      if (context.previous !== undefined) {
        queryClient.setQueryData(queryKey, context.previous);
      } else {
        // Nothing confirmed to fall back to: let the query fetch it again.
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });

  const { mutate, reset } = mutation;
  const setEnabled = useCallback(
    (next: boolean) => {
      reset();
      mutate(next);
    },
    [mutate, reset]
  );

  const error = mutation.isError
    ? mutation.error instanceof Error && mutation.error.message
      ? mutation.error.message
      : messages.save
    : loadFailed && !loaded
      ? messages.load
      : "";

  return { enabled, loaded, error, setEnabled };
}
```

- [ ] **Step 3: Reduce the chat-surface hook to two wrappers**

Replace the entire contents of `apps/web/src/hooks/use-chat-surface-enabled.ts` with:

```ts
import {
  type ServerFlagSetting,
  useServerFlag,
  useServerFlagSetting,
} from "@/hooks/use-server-flag";
import { chatSurfaceEnabledHintAtom } from "@/lib/store";

export const CHAT_SURFACE_ENDPOINT = "/api/v1/app/settings/chat-surface";

/**
 * The `chat_surface_enabled` feature flag: a `useServerFlag` over the
 * chat-surface endpoint, with `chatSurfaceEnabledHintAtom` standing in for
 * the value until the first fetch resolves so the first paint of an agent
 * already knows which tab to show. The settings toggle
 * (`useChatSurfaceSetting`) writes through the same query, so the tab bar
 * and routing react the moment the user flips it.
 */
export function useChatSurfaceEnabled(): { enabled: boolean; loaded: boolean } {
  return useServerFlag(CHAT_SURFACE_ENDPOINT, chatSurfaceEnabledHintAtom);
}

export type ChatSurfaceSetting = ServerFlagSetting;

/** The settings-page toggle for the flag. See `useServerFlagSetting`. */
export function useChatSurfaceSetting(): ChatSurfaceSetting {
  return useServerFlagSetting(
    CHAT_SURFACE_ENDPOINT,
    chatSurfaceEnabledHintAtom,
    {
      save: "Failed to save chat surface setting.",
      load: "Failed to load chat surface setting.",
    }
  );
}
```

- [ ] **Step 4: Run the untouched suite to verify nothing changed**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/hooks/use-chat-surface-enabled.test.tsx`

Expected: PASS, 8 passed, the same count as Step 1, with no edit to the test file.

- [ ] **Step 5: Type check and lint**

Run: `cd /home/nii/.dispatch/server-dsh-harness && pnpm run check`

Expected: exit 0, no `error TS` lines.

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/web && pnpm exec eslint src/hooks/use-server-flag.ts src/hooks/use-chat-surface-enabled.ts`

Expected: no output, exit 0. In particular no `@typescript-eslint/no-unused-vars` from a leftover import.

- [ ] **Step 6: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/web/src/hooks/use-server-flag.ts apps/web/src/hooks/use-chat-surface-enabled.ts
git commit -m "$(cat <<'EOF'
refactor(web): extract the server flag setting hook

The optimistic write, the in-flight GET cancel and the sequence guard
were 60 lines welded to one endpoint, and a second flag would have
copied every one of them. Move the state machine into use-server-flag
and leave the chat-surface hook as two wrappers.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: The web side of the flag: hint atom and hook pair

**Files:**

- Modify: `apps/web/src/lib/store.ts` (after the `chatSurfaceEnabledHintAtom` block, which ends at line 150)
- Create: `apps/web/src/hooks/use-dispatch-harness-enabled.ts`
- Create: `apps/web/src/hooks/use-dispatch-harness-enabled.test.tsx`

**Interfaces:**

- Consumes: `useServerFlag(endpoint, hintAtom)` and `useServerFlagSetting(endpoint, hintAtom, messages)` with `type ServerFlagSetting`, from `@/hooks/use-server-flag` (Task 7). `atomWithLocalStorage<T>(key, initialValue)` from `@/lib/store`.
- Produces: `dispatchHarnessEnabledHintAtom` (a `boolean | null` `atomWithLocalStorage` on key `dispatch:dispatchHarnessEnabledHint`) from `@/lib/store`. `DISPATCH_HARNESS_ENDPOINT = "/api/v1/app/settings/dispatch-harness"`, `useDispatchHarnessEnabled(): { enabled: boolean; loaded: boolean }` and `useDispatchHarnessSetting(): ServerFlagSetting`, all from `@/hooks/use-dispatch-harness-enabled`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/hooks/use-dispatch-harness-enabled.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchHarnessEnabledHintAtom } from "@/lib/store";

import {
  DISPATCH_HARNESS_ENDPOINT,
  useDispatchHarnessEnabled,
  useDispatchHarnessSetting,
} from "./use-dispatch-harness-enabled";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

const HINT_KEY = "dispatch:dispatchHarnessEnabledHint";

/** The setting and the flag read together, the way Settings and routing do. */
function renderBoth() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderHook(
    () => ({
      setting: useDispatchHarnessSetting(),
      flag: useDispatchHarnessEnabled(),
    }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  );
}

const isPost = (call: unknown[]) =>
  (call[1] as { method?: string } | undefined)?.method === "POST";

beforeEach(() => {
  window.localStorage.clear();
  getDefaultStore().set(dispatchHarnessEnabledHintAtom, null);
  apiMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useDispatchHarnessEnabled", () => {
  it("is off and unloaded on a browser that has never fetched the flag", () => {
    apiMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderBoth();
    expect(result.current.flag).toEqual({ enabled: false, loaded: false });
  });

  it("reads the flag from its own endpoint and remembers it", async () => {
    apiMock.mockResolvedValue({ enabled: true });
    const { result } = renderBoth();
    await waitFor(() => expect(result.current.flag.enabled).toBe(true));
    expect(apiMock).toHaveBeenCalledWith(DISPATCH_HARNESS_ENDPOINT);
    await waitFor(() =>
      expect(window.localStorage.getItem(HINT_KEY)).toBe("true")
    );
  });

  it("answers from the remembered value before the fetch resolves", () => {
    getDefaultStore().set(dispatchHarnessEnabledHintAtom, true);
    apiMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderBoth();
    expect(result.current.flag).toEqual({ enabled: true, loaded: true });
  });
});

describe("useDispatchHarnessSetting", () => {
  // The card and the offered-types list read one cache, so a toggle has to
  // reach the reader without a refetch.
  it("writes through the same query the flag reads", async () => {
    apiMock.mockResolvedValue({ enabled: false });
    const { result } = renderBoth();
    await waitFor(() => expect(result.current.setting.loaded).toBe(true));
    expect(result.current.flag.enabled).toBe(false);

    apiMock.mockResolvedValue({ enabled: true });
    act(() => result.current.setting.setEnabled(true));

    await waitFor(() => expect(result.current.flag.enabled).toBe(true));
    const post = apiMock.mock.calls.find(isPost)!;
    expect(post[0]).toBe(DISPATCH_HARNESS_ENDPOINT);
    expect(JSON.parse((post[1] as { body: string }).body)).toEqual({
      enabled: true,
    });
  });

  it("reports its own message when a POST fails without one", async () => {
    apiMock.mockResolvedValue({ enabled: false });
    const { result } = renderBoth();
    await waitFor(() => expect(result.current.setting.loaded).toBe(true));

    apiMock.mockRejectedValue(new Error(""));
    act(() => result.current.setting.setEnabled(true));

    await waitFor(() =>
      expect(result.current.setting.error).toBe(
        "Failed to save Dispatch Harness setting."
      )
    );
    expect(result.current.flag.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/hooks/use-dispatch-harness-enabled.test.tsx`

Expected: FAIL at collection with `Failed to resolve import "./use-dispatch-harness-enabled"`.

- [ ] **Step 3: Add the hint atom**

In `apps/web/src/lib/store.ts`, add this immediately after the `chatSurfaceEnabledHintAtom` declaration (which closes with `);` on line 150) and before the cross-repo-messaging comment block:

```ts
/**
 * Last value of the `dispatch_harness_enabled` flag this browser saw. The
 * server owns the flag (see `useDispatchHarnessEnabled`); this only lets the
 * first paint of the create dialog and the type pickers know whether the
 * Dispatch Harness is on offer before the fetch resolves, so the type does
 * not appear and then vanish. `null` until the first fetch.
 */
export const dispatchHarnessEnabledHintAtom = atomWithLocalStorage<
  boolean | null
>("dispatch:dispatchHarnessEnabledHint", null);
```

- [ ] **Step 4: Add the hook pair**

Create `apps/web/src/hooks/use-dispatch-harness-enabled.ts`:

```ts
import {
  type ServerFlagSetting,
  useServerFlag,
  useServerFlagSetting,
} from "@/hooks/use-server-flag";
import { dispatchHarnessEnabledHintAtom } from "@/lib/store";

export const DISPATCH_HARNESS_ENDPOINT =
  "/api/v1/app/settings/dispatch-harness";

/**
 * The `dispatch_harness_enabled` feature flag: whether the Dispatch Harness
 * agent type is on offer. `dispatch` is never a member of the enabled
 * agent types the server persists, so this flag is the only thing that puts
 * the type in the create dialog, the sidebar picker, jobs, templates and the
 * reviewer pickers.
 *
 * `dispatchHarnessEnabledHintAtom` stands in for the value until the first
 * fetch resolves, so the type does not appear and then vanish on first paint.
 * The settings toggle (`useDispatchHarnessSetting`) writes through the same
 * query, so the pickers react the moment the user flips it.
 *
 * The flag gates creation and discovery only: a running dispatch agent keeps
 * running and keeps its pane when the flag goes off.
 */
export function useDispatchHarnessEnabled(): {
  enabled: boolean;
  loaded: boolean;
} {
  return useServerFlag(
    DISPATCH_HARNESS_ENDPOINT,
    dispatchHarnessEnabledHintAtom
  );
}

/** The settings-page toggle for the flag. See `useServerFlagSetting`. */
export function useDispatchHarnessSetting(): ServerFlagSetting {
  return useServerFlagSetting(
    DISPATCH_HARNESS_ENDPOINT,
    dispatchHarnessEnabledHintAtom,
    {
      save: "Failed to save Dispatch Harness setting.",
      load: "Failed to load Dispatch Harness setting.",
    }
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/hooks/use-dispatch-harness-enabled.test.tsx`

Expected: PASS, 5 passed.

- [ ] **Step 6: Type check**

Run: `cd /home/nii/.dispatch/server-dsh-harness && pnpm run check`

Expected: exit 0, no `error TS` lines.

- [ ] **Step 7: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/web/src/lib/store.ts apps/web/src/hooks/use-dispatch-harness-enabled.ts apps/web/src/hooks/use-dispatch-harness-enabled.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): read the dispatch harness flag

Nothing on the client could tell whether the harness was on offer once
the server stopped carrying dispatch in the enabled agent types. Add the
flag hook pair and its remembered value, so the type pickers have one
source to ask.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: The Settings card, and the agent-type list stops offering `dispatch`

**Files:**

- Create: `apps/web/src/components/app/dispatch-harness-settings.tsx`
- Create: `apps/web/src/components/app/dispatch-harness-settings.test.tsx`
- Modify: `apps/web/src/components/app/settings-pane.tsx` (import near line 7, mount after line 226)
- Modify: `apps/web/src/components/app/settings-pane.test.tsx` (a new `vi.mock`, and the agents-section panel list at lines 284-295)
- Modify: `apps/web/src/components/app/agent-type-settings.tsx`
- Create: `apps/web/src/components/app/agent-type-settings.test.tsx`

**Interfaces:**

- Consumes: `useDispatchHarnessSetting(): ServerFlagSetting` from `@/hooks/use-dispatch-harness-enabled` (Task 8). `ToggleSettingCard` from `@/components/app/toggle-setting-card`, whose props are `{ eyebrow: string; description: ReactNode; label: ReactNode; hint: ReactNode; testId: string; checked: boolean; onCheckedChange: (checked: boolean) => void; error: string }`.
- Produces: `DispatchHarnessSettings(): JSX.Element` from `@/components/app/dispatch-harness-settings`, rendering a checkbox with `data-testid="dispatch-harness-toggle"`. `AgentTypeSettings` no longer renders `agent-type-toggle-dispatch`.

Copy, exactly:

| Slot        | Text                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eyebrow     | `Dispatch Harness`                                                                                                                                                                       |
| description | `Dispatch's own view over Claude Code, Codex, Gemini CLI, or OpenCode. Needs the engine's CLI installed and logged in on the server (see the runbook's Dispatch Harness engines table).` |
| label       | `Dispatch Harness (beta)`                                                                                                                                                                |
| hint        | `Turning this off stops new dispatch agents from being created and leaves the ones already running alone.`                                                                               |
| testId      | `dispatch-harness-toggle`                                                                                                                                                                |

The card lists no agents. The one hint sentence is the whole answer to "what happens to what is running".

- [ ] **Step 1: Write the failing card test**

Create `apps/web/src/components/app/dispatch-harness-settings.test.tsx`:

```tsx
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDispatchHarnessEnabled } from "@/hooks/use-dispatch-harness-enabled";
import { dispatchHarnessEnabledHintAtom } from "@/lib/store";

import { DispatchHarnessSettings } from "./dispatch-harness-settings";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

/** Reads the flag the way routing and the type pickers do. */
function FlagProbe(): JSX.Element {
  const { enabled } = useDispatchHarnessEnabled();
  return <span data-testid="flag">{enabled ? "on" : "off"}</span>;
}

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DispatchHarnessSettings />
      <FlagProbe />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  getDefaultStore().set(dispatchHarnessEnabledHintAtom, null);
  apiMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("DispatchHarnessSettings", () => {
  it("says what turning it off does to agents already running", async () => {
    apiMock.mockResolvedValue({ enabled: false });
    renderCard();

    await waitFor(() =>
      expect(screen.getByTestId("dispatch-harness-toggle")).not.toBeNull()
    );
    expect(screen.getByText("Dispatch Harness (beta)")).not.toBeNull();
    expect(
      screen.getByText(
        "Turning this off stops new dispatch agents from being created and leaves the ones already running alone."
      )
    ).not.toBeNull();
  });

  // One cache: the card is a write-through, not a second copy of the value.
  it("writes through the same query the flag reads", async () => {
    apiMock.mockResolvedValue({ enabled: false });
    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId("flag").textContent).toBe("off")
    );

    apiMock.mockResolvedValue({ enabled: true });
    fireEvent.click(screen.getByTestId("dispatch-harness-toggle"));

    await waitFor(() =>
      expect(screen.getByTestId("flag").textContent).toBe("on")
    );
    const post = apiMock.mock.calls.find(
      (call) => (call[1] as { method?: string } | undefined)?.method === "POST"
    )!;
    expect(post[0]).toBe("/api/v1/app/settings/dispatch-harness");
    expect(JSON.parse((post[1] as { body: string }).body)).toEqual({
      enabled: true,
    });
  });

  it("shows the error line when the write fails", async () => {
    apiMock.mockResolvedValue({ enabled: false });
    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId("flag").textContent).toBe("off")
    );

    apiMock.mockRejectedValue(new Error("server said no"));
    fireEvent.click(screen.getByTestId("dispatch-harness-toggle"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("server said no")
    );
  });
});
```

- [ ] **Step 2: Write the failing agent-type-list test**

Create `apps/web/src/components/app/agent-type-settings.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentTypeSettings } from "./agent-type-settings";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: apiMock }));

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue({
    enabledAgentTypes: ["claude", "codex", "terminal"],
  });
});

afterEach(() => {
  cleanup();
});

describe("AgentTypeSettings", () => {
  it("offers every CLI type and the terminal", async () => {
    render(
      <AgentTypeSettings enabledAgentTypes={["claude"]} onChange={vi.fn()} />
    );

    await waitFor(() =>
      expect(screen.getByTestId("agent-type-toggle-claude")).not.toBeNull()
    );
    for (const type of ["codex", "cursor", "opencode", "terminal"]) {
      expect(screen.getByTestId(`agent-type-toggle-${type}`)).not.toBeNull();
    }
  });

  // The Dispatch Harness has its own card. A checkbox here would be a second
  // switch, and its POST would be refused by the server.
  it("does not offer the harness", async () => {
    render(
      <AgentTypeSettings enabledAgentTypes={["claude"]} onChange={vi.fn()} />
    );

    await waitFor(() =>
      expect(screen.getByTestId("agent-type-toggle-claude")).not.toBeNull()
    );
    expect(screen.queryByTestId("agent-type-toggle-dispatch")).toBeNull();
    expect(screen.queryByText(/Dispatch's own view over/)).toBeNull();
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/dispatch-harness-settings.test.tsx src/components/app/agent-type-settings.test.tsx`

Expected: FAIL. The card file fails at collection with `Failed to resolve import "./dispatch-harness-settings"`; `does not offer the harness` fails on `expect(received).toBeNull()` because `agent-type-toggle-dispatch` is rendered.

- [ ] **Step 4: Write the card**

Create `apps/web/src/components/app/dispatch-harness-settings.tsx`:

```tsx
import { ToggleSettingCard } from "@/components/app/toggle-setting-card";
import { useDispatchHarnessSetting } from "@/hooks/use-dispatch-harness-enabled";

/**
 * Toggle for the Dispatch Harness agent type. This is the only place the
 * harness is turned on: it is deliberately not a checkbox in the agent-type
 * list, because that list is persisted server-side and two switches for one
 * type could disagree.
 *
 * Server-owned like the other flags (GET on mount, POST on an explicit
 * toggle), and it lives in the React Query cache the type pickers read, so
 * flipping it here adds or removes the type from the create dialog without a
 * reload. See `useDispatchHarnessSetting` for the optimistic write.
 */
export function DispatchHarnessSettings(): JSX.Element {
  const { enabled, error, setEnabled } = useDispatchHarnessSetting();

  return (
    <ToggleSettingCard
      eyebrow="Dispatch Harness"
      description={
        <>
          Dispatch&apos;s own view over Claude Code, Codex, Gemini CLI, or
          OpenCode. Needs the engine&apos;s CLI installed and logged in on the
          server (see the runbook&apos;s Dispatch Harness engines table).
        </>
      }
      label="Dispatch Harness (beta)"
      hint="Turning this off stops new dispatch agents from being created and leaves the ones already running alone."
      testId="dispatch-harness-toggle"
      checked={enabled}
      onCheckedChange={setEnabled}
      error={error}
    />
  );
}
```

- [ ] **Step 5: Mount the card next to the chat-surface card**

In `apps/web/src/components/app/settings-pane.tsx`, add this import immediately after the `ChatSurfaceSettings` import on line 7:

```ts
import { DispatchHarnessSettings } from "@/components/app/dispatch-harness-settings";
```

Then, in the `activeSection === "agents"` branch, add this block immediately after the chat-surface wrapper (the `<div className="border-t border-border">` that holds `<ChatSurfaceSettings />` and closes with `</div>` on line 226) and before the wrapper holding `<UsageBudgetSettings />`:

```tsx
<div className="border-t border-border">
  <DispatchHarnessSettings />
</div>
```

- [ ] **Step 6: Take `dispatch` out of the agent-type list**

In `apps/web/src/components/app/agent-type-settings.tsx`, change the import block at lines 6-10 from:

```ts
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  CLI_AGENT_TYPES,
} from "@/lib/agent-types";
```

to:

```ts
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  CLI_AGENT_TYPES,
} from "@/lib/agent-types";

/**
 * Every type this card can toggle. The Dispatch Harness is not one: it has
 * its own setting (`DispatchHarnessSettings`), and the server answers 400 to
 * an agent-types POST that names it, so a checkbox here would be a switch
 * that cannot be saved.
 */
type ToggleableAgentType = Exclude<AgentType, "dispatch">;

function isToggleableAgentType(type: AgentType): type is ToggleableAgentType {
  return type !== "dispatch";
}

const TOGGLEABLE_CLI_AGENT_TYPES: ToggleableAgentType[] = (
  CLI_AGENT_TYPES as readonly AgentType[]
).filter(isToggleableAgentType);
```

Replace the description record at lines 16-24 with the following. Two changes beyond dropping the `dispatch` key: the record's key type narrows, and OpenCode's em-dash goes, because this plan's copy rule bans em-dashes and this is the line that carries the one in this file.

```ts
const AGENT_TYPE_DESCRIPTIONS: Record<ToggleableAgentType, string> = {
  claude: "Claude Code CLI by Anthropic.",
  codex: "Codex CLI by OpenAI.",
  cursor: "Cursor Agent CLI by Anysphere.",
  opencode: "OpenCode CLI, an open-source terminal agent.",
  terminal: "Raw shell session with no AI agent.",
};
```

Change the `AgentTypeRow` prop type at line 37 from `agentType: AgentType;` to:

```ts
agentType: ToggleableAgentType;
```

Change the state at line 75 from:

```ts
const [agentTypes, setAgentTypes] = useState<AgentType[]>(enabledAgentTypes);
```

to:

```ts
// Filtered on the way in as well as out: a prerelease install can still
// have `dispatch` in the persisted row, and letting it into this state
// would put it in the next POST body, which the server refuses.
const [agentTypes, setAgentTypes] = useState<ToggleableAgentType[]>(() =>
  enabledAgentTypes.filter(isToggleableAgentType)
);
```

Change the sync effect at lines 79-81 from:

```ts
useEffect(() => {
  setAgentTypes(enabledAgentTypes);
}, [enabledAgentTypes]);
```

to:

```ts
useEffect(() => {
  setAgentTypes(enabledAgentTypes.filter(isToggleableAgentType));
}, [enabledAgentTypes]);
```

Change the fetch handler at lines 89-90 from:

```ts
setAgentTypes(data.enabledAgentTypes);
onChange(data.enabledAgentTypes);
```

to:

```ts
setAgentTypes(data.enabledAgentTypes.filter(isToggleableAgentType));
onChange(data.enabledAgentTypes);
```

Change the `toggleAgentType` signature at line 111 from `async (agentType: AgentType) => {` to:

```ts
    async (agentType: ToggleableAgentType) => {
```

and its response handler at lines 130-131 from:

```ts
setAgentTypes(data.enabledAgentTypes);
onChange(data.enabledAgentTypes);
```

to:

```ts
setAgentTypes(data.enabledAgentTypes.filter(isToggleableAgentType));
onChange(data.enabledAgentTypes);
```

Change the section copy at lines 156-159 from:

```tsx
<p className="mb-3 max-w-2xl text-sm text-muted-foreground">
  Choose which agent runtimes can be created from the app. Disabled types are
  removed from the create-agent dialog.
</p>
```

to:

```tsx
<p className="mb-3 max-w-2xl text-sm text-muted-foreground">
  Choose which agent runtimes can be created from the app. Disabled types are
  removed from the create-agent dialog. The Dispatch Harness has its own switch
  below.
</p>
```

Finally change the list at line 163 from `{CLI_AGENT_TYPES.map((agentType) => {` to:

```tsx
        {TOGGLEABLE_CLI_AGENT_TYPES.map((agentType) => {
```

- [ ] **Step 7: Update the settings-pane routing test**

In `apps/web/src/components/app/settings-pane.test.tsx`, add this mock immediately after the `chat-surface-settings` mock (which ends with its `);` on line 51):

```ts
vi.mock(
  "@/components/app/dispatch-harness-settings",
  stubModule("DispatchHarnessSettings")
);
```

Then in the `it.each` panel-order table, replace the `"agents"` row's array (lines 284-295, from `[` through `],`) with:

```ts
      [
        "PersonalitySettings",
        "AgentTypeSettings",
        "IdeSettings",
        "LaunchGuidanceSettings",
        "PluginUpdateSettings",
        "InjectionHoldSettings",
        "CrossRepoMessagingSettings",
        "ChatSurfaceSettings",
        "DispatchHarnessSettings",
        "UsageBudgetSettings",
        "WorktreeLocationSettings",
      ],
```

- [ ] **Step 8: Run the three web test files to verify they pass**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/dispatch-harness-settings.test.tsx src/components/app/agent-type-settings.test.tsx src/components/app/settings-pane.test.tsx`

Expected: PASS, 0 failed.

- [ ] **Step 9: Type check, lint, and build the web app**

Run: `cd /home/nii/.dispatch/server-dsh-harness && pnpm run finalize:web`

Expected: exit 0, ending with the Vite build summary and no `error TS` lines.

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/web && pnpm exec eslint src/components/app/dispatch-harness-settings.tsx src/components/app/agent-type-settings.tsx src/components/app/settings-pane.tsx`

Expected: no output, exit 0.

- [ ] **Step 10: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/web/src/components/app/dispatch-harness-settings.tsx apps/web/src/components/app/dispatch-harness-settings.test.tsx apps/web/src/components/app/agent-type-settings.tsx apps/web/src/components/app/agent-type-settings.test.tsx apps/web/src/components/app/settings-pane.tsx apps/web/src/components/app/settings-pane.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): add the dispatch harness settings card

The harness checkbox in the agent-type list wrote to an endpoint that
now refuses it, so the only switch for the type was one that could not
be saved. Give it its own card next to the chat-surface flag and drop
the row, so the type appears in exactly one place in Settings.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: The offered list reaches every creation and discovery surface

**Files:**

- Modify: `apps/web/src/lib/agent-types.ts` (the re-export block at lines 14-22, plus a new function)
- Modify: `apps/web/src/lib/agent-types.test.ts` (append a describe)
- Modify: `apps/web/src/components/app/dashboard-context.ts:13`
- Modify: `apps/web/src/App.tsx` (line 1, the import block at lines 20-24, the state at line 70, the context at line 175)
- Modify: `apps/web/src/layouts/dashboard-sections.tsx:120`, `:140`, `:149`, `:157`
- Modify: `apps/web/src/layouts/dashboard-sections.test.tsx` (the import at lines 12-17, the context fake at lines 202-233, the `renderAt` route table at lines 250-266, plus three new cases)

**Interfaces:**

- Consumes: `useDispatchHarnessEnabled(): { enabled: boolean; loaded: boolean }` from `@/hooks/use-dispatch-harness-enabled` (Task 8). `DEFAULT_ENABLED_AGENT_TYPES`, exported from `apps/server/src/shared/agent-types.ts` and re-exported by `@/lib/agent-types` in this task.
- Produces: `offeredAgentTypes(enabledAgentTypes: AgentType[], dispatchHarnessEnabled: boolean): AgentType[]` from `@/lib/agent-types`. `DashboardContextValue.offeredAgentTypes: AgentType[]`.

- [ ] **Step 1: Write the failing helper test**

Append to `apps/web/src/lib/agent-types.test.ts`. Extend its import block (lines 3-12) to include `offeredAgentTypes`:

```ts
import {
  AGENT_TYPES,
  CLI_AGENT_TYPES,
  defaultReviewAgentType,
  isAgentType,
  isCliAgentType,
  offeredAgentTypes,
  sanitizeEnabledAgentTypes,
  sortAgentTypes,
  type AgentType,
} from "./agent-types";
```

Then append this describe at the end of the file:

```ts
describe("offeredAgentTypes", () => {
  const enabled: AgentType[] = ["claude", "codex"];

  it("is the enabled types with the harness flag off", () => {
    expect(offeredAgentTypes(enabled, false)).toEqual(["claude", "codex"]);
  });

  it("adds the harness last with the flag on", () => {
    expect(offeredAgentTypes(enabled, true)).toEqual([
      "claude",
      "codex",
      "dispatch",
    ]);
  });

  // Handed straight to a useMemo, so a no-op has to keep its identity or
  // every picker below it re-renders on each parent render.
  it("returns the same array with the flag off", () => {
    expect(offeredAgentTypes(enabled, false)).toBe(enabled);
  });

  it("leaves the input alone", () => {
    offeredAgentTypes(enabled, true);
    expect(enabled).toEqual(["claude", "codex"]);
  });
});
```

- [ ] **Step 2: Write the failing wiring test**

In `apps/web/src/layouts/dashboard-sections.test.tsx`, replace the import from `./dashboard-sections` at lines 12-17 with:

```ts
import {
  AgentsRoute,
  AutomationsRoute,
  ActivityRoute,
  SettingsRoute,
  serviceDotClass,
} from "./dashboard-sections";
```

Add `offeredAgentTypes` to `defaultContext()` immediately after its `enabledAgentTypes` line (line 205):

```ts
    offeredAgentTypes: ["claude", "dispatch"],
```

Add an agents route to the `renderAt` helper, immediately before the `/automations` route on line 254:

```tsx
<Route path="/agents" element={<AgentsRoute />} />
```

Then append this describe at the end of the file:

```tsx
// The two lists are the same type, so a route wired to the wrong one still
// type-checks. `enabledAgentTypes` is what Settings edits and never holds
// `dispatch`; `offeredAgentTypes` is what may be created right now.
describe("which agent-type list reaches which route", () => {
  it("hands the offered list to the agents route", () => {
    renderAt("/agents");

    expect(propsOf("AgentsView").enabledAgentTypes).toEqual([
      "claude",
      "dispatch",
    ]);
  });

  it("hands the offered list to both halves of the automations route", () => {
    renderAt("/automations");

    expect(propsOf("AutomationsSidebarContent").enabledAgentTypes).toEqual([
      "claude",
      "dispatch",
    ]);
    expect(propsOf("AutomationsDetailContent").enabledAgentTypes).toEqual([
      "claude",
      "dispatch",
    ]);
  });

  it("hands the persisted list to settings, which is what edits it", () => {
    renderAt("/settings");

    expect(propsOf("SettingsContent").enabledAgentTypes).toEqual(["claude"]);
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/lib/agent-types.test.ts src/layouts/dashboard-sections.test.tsx`

Expected: FAIL. `agent-types.test.ts` fails at collection with `"offeredAgentTypes" is not exported`; the two "hands the offered list" cases fail with received `["claude"]`.

- [ ] **Step 4: Add the helper**

In `apps/web/src/lib/agent-types.ts`, add `DEFAULT_ENABLED_AGENT_TYPES` to the re-export block at lines 14-22:

```ts
export {
  AGENT_TYPES,
  CLI_AGENT_TYPES,
  DEFAULT_ENABLED_AGENT_TYPES,
  isAgentType,
  isCliAgentType,
  sanitizeEnabledAgentTypes,
  type AgentType,
  type CliAgentType,
} from "../../../server/src/shared/agent-types";
```

Then append to the end of the file:

```ts
/**
 * What may be created right now: the enabled types the server persists, plus
 * `dispatch` when the Dispatch Harness flag is on. `dispatch` is never a
 * member of the persisted list (the server drops it on read and on write), so
 * the flag is the one place the harness enters, and every create dialog, job,
 * template and reviewer picker reads the result.
 *
 * Returns `enabledAgentTypes` itself when the flag is off, so a `useMemo` over
 * this keeps its identity.
 */
export function offeredAgentTypes(
  enabledAgentTypes: AgentType[],
  dispatchHarnessEnabled: boolean
): AgentType[] {
  if (!dispatchHarnessEnabled) return enabledAgentTypes;
  return [...enabledAgentTypes, "dispatch"];
}
```

- [ ] **Step 5: Add the context field**

In `apps/web/src/components/app/dashboard-context.ts`, replace line 13 (`enabledAgentTypes: AgentType[];`) with:

```ts
  /** The persisted list. Settings edits this, and it never holds `dispatch`. */
  enabledAgentTypes: AgentType[];
  /**
   * What may be created right now: `enabledAgentTypes` plus `dispatch` when
   * the Dispatch Harness flag is on. Every create dialog, sidebar picker, job,
   * template and reviewer picker reads this one.
   */
  offeredAgentTypes: AgentType[];
```

- [ ] **Step 6: Derive it in `App.tsx`**

In `apps/web/src/App.tsx`, change line 1 from:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
```

to:

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
```

Change the agent-types import block at lines 20-24 from:

```ts
import {
  AGENT_TYPES,
  type AgentType,
  sanitizeEnabledAgentTypes,
} from "@/lib/agent-types";
```

to:

```ts
import {
  type AgentType,
  DEFAULT_ENABLED_AGENT_TYPES,
  offeredAgentTypes,
  sanitizeEnabledAgentTypes,
} from "@/lib/agent-types";
```

and add this import after the `useTemporaryState` import on line 19:

```ts
import { useDispatchHarnessEnabled } from "@/hooks/use-dispatch-harness-enabled";
```

Change the state at lines 70-72 from:

```ts
const [enabledAgentTypes, setEnabledAgentTypes] = useState<AgentType[]>([
  ...AGENT_TYPES,
]);
```

to:

```ts
// The pre-fetch guess. `dispatch` is not in it: it never comes back from
// the agent-types endpoint, and offering it before the flag resolves would
// show a type that then vanishes.
const [enabledAgentTypes, setEnabledAgentTypes] = useState<AgentType[]>([
  ...DEFAULT_ENABLED_AGENT_TYPES,
]);
```

Then add this immediately after the `enabledIdes` state declaration on line 73:

```ts
const { enabled: dispatchHarnessEnabled } = useDispatchHarnessEnabled();
const offered = useMemo(
  () => offeredAgentTypes(enabledAgentTypes, dispatchHarnessEnabled),
  [enabledAgentTypes, dispatchHarnessEnabled]
);
```

Finally, in the `context` object, add the new field immediately after `enabledAgentTypes,` (line 175):

```ts
    offeredAgentTypes: offered,
```

- [ ] **Step 7: Hand the right list to each route**

In `apps/web/src/layouts/dashboard-sections.tsx`, change line 120 in `AgentsRoute` from:

```tsx
      enabledAgentTypes={context.enabledAgentTypes}
```

to:

```tsx
      // The offered list: the create dialog, the sidebar type picker, the
      // persona launcher and agent-card actions all hang off this prop.
      enabledAgentTypes={context.offeredAgentTypes}
```

Change the destructure at lines 140-141 in `AutomationsRoute` from:

```tsx
const { agents, enabledAgentTypes, isMobile, setMobileLeftOpen } =
  useDashboardContext();
```

to:

```tsx
// Jobs and templates are creation surfaces, so both halves of this route
// read the offered list rather than the persisted one.
const { agents, offeredAgentTypes, isMobile, setMobileLeftOpen } =
  useDashboardContext();
```

Then change line 149 from `enabledAgentTypes={enabledAgentTypes}` to:

```tsx
enabledAgentTypes = { offeredAgentTypes };
```

and line 157 from `enabledAgentTypes={enabledAgentTypes}` to:

```tsx
enabledAgentTypes = { offeredAgentTypes };
```

Leave `SettingsRoute` at line 212 on `context.enabledAgentTypes`, and add a comment above it:

```tsx
          // The persisted list, not the offered one: this is the list the
          // agent-type card edits, and `dispatch` is never a member of it.
          enabledAgentTypes={context.enabledAgentTypes}
```

- [ ] **Step 8: Run the web tests to verify they pass**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/lib/agent-types.test.ts src/layouts/dashboard-sections.test.tsx`

Expected: PASS, 0 failed.

- [ ] **Step 9: Run the whole web suite**

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run`

Expected: PASS, 0 failed. Every web change in this plan is in at this point, so the whole suite is the gate.

- [ ] **Step 10: Type check, lint, and build the web app**

Run: `cd /home/nii/.dispatch/server-dsh-harness && pnpm run finalize:web`

Expected: exit 0, ending with the Vite build summary and no `error TS` lines.

Run: `cd /home/nii/.dispatch/server-dsh-harness/apps/web && pnpm exec eslint src/App.tsx src/lib/agent-types.ts src/components/app/dashboard-context.ts src/layouts/dashboard-sections.tsx`

Expected: no output, exit 0.

- [ ] **Step 11: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add apps/web/src/lib/agent-types.ts apps/web/src/lib/agent-types.test.ts apps/web/src/components/app/dashboard-context.ts apps/web/src/App.tsx apps/web/src/layouts/dashboard-sections.tsx apps/web/src/layouts/dashboard-sections.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): offer the harness type from its flag

Every type picker read the persisted enabled types, which no longer
carry dispatch, so the harness had vanished from the create dialog,
jobs, templates and the reviewer pickers. Derive an offered list from
the flag and hand that to the creation surfaces, leaving Settings on
the persisted one.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: E2E, the helper and the specs that set the type

**Files:**

- Modify: `e2e/helpers.ts` (after `setEnabledAgentTypesViaAPI`, which ends at line 168)
- Modify: `e2e/harness-agent.spec.ts:7-14`, `:102-106`, `:193`, `:262`, `:338`
- Modify: `e2e/settings.spec.ts` (the import at lines 2-6, the `afterEach` at lines 9-32, plus a new test after line 332)
- Modify: `playwright.config.ts:32` (comment only)

**Interfaces:**

- Consumes: `POST /api/v1/app/settings/dispatch-harness` taking `{ enabled: boolean }` (Task 1). The `dispatch-harness-toggle` testid (Task 9).
- Produces: `setDispatchHarnessViaAPI(request: APIRequestContext, enabled: boolean): Promise<void>` from `e2e/helpers.ts`.

`setEnabledAgentTypesViaAPI` keeps its signature and its route. Because the route now answers `400` for a body naming `dispatch`, the helper's existing non-ok throw (`e2e/helpers.ts:164-166`) turns a stale call into a loud failure rather than a silent no-op, which is why nothing else about it changes.

`e2e/chat-surface.spec.ts` needs no change in this plan: it never calls `setEnabledAgentTypesViaAPI`, and its `getByTestId("chat-surface-toggle")` at line 107 is unaffected by a new sibling card. Its dispatch-agent case belongs to a later plan. `e2e/fixtures/fake-acp-agent.mjs` needs no change: it is the engine, and knows nothing about settings.

- [ ] **Step 1: Write the failing Settings test**

In `e2e/settings.spec.ts`, extend the import at lines 2-6 to:

```ts
import {
  createAgentViaAPI,
  loadApp,
  setDispatchHarnessViaAPI,
  setEnabledAgentTypesViaAPI,
} from "./helpers";
```

Add this to the `afterEach`, immediately after the `setEnabledAgentTypesViaAPI` call on line 10:

```ts
await setDispatchHarnessViaAPI(request, false);
```

Then add this test immediately after `test("cross-repo messaging toggle defaults off and persists to the server", ...)` (which ends with its `});` on line 332):

```ts
test("the Dispatch Harness has one switch of its own, not a type checkbox", async ({
  page,
  request,
}) => {
  await loadApp(page);

  await page.getByTestId("settings-button").click();
  await page
    .getByTestId("sidebar-shell")
    .getByText("Agents", { exact: true })
    .click();

  // The type list is not where the harness is turned on.
  await expect(page.getByTestId("agent-type-toggle-claude")).toBeVisible();
  await expect(page.getByTestId("agent-type-toggle-dispatch")).toHaveCount(0);

  const toggle = page.getByTestId("dispatch-harness-toggle");
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).not.toBeChecked();

  await toggle.check();
  await expect(toggle).toBeChecked();

  await expect
    .poll(async () => {
      const res = await request.get("/api/v1/app/settings/dispatch-harness", {
        headers: {
          Authorization: `Bearer ${process.env.AUTH_TOKEN ?? "dev-token"}`,
        },
      });
      return (await res.json()).enabled;
    })
    .toBe(true);

  // With the flag on, the create dialog offers the type from that one place.
  await page.getByTestId("agents-button").click();
  await page.getByTestId("create-agent-button").click();
  const form = page.getByTestId("create-agent-form");
  await expect(form).toBeVisible();
  await form.getByRole("combobox").first().click();
  await expect(page.getByRole("option", { name: "Dispatch" })).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/nii/.dispatch/server-dsh-harness && bash scripts/e2e-isolated.sh e2e/settings.spec.ts`

Expected: FAIL at load with `does not provide an export named 'setDispatchHarnessViaAPI'`.

- [ ] **Step 3: Add the helper**

In `e2e/helpers.ts`, add this immediately after `setEnabledAgentTypesViaAPI` (which closes with `}` on line 168) and before `uploadMediaViaAPI`:

```ts
/**
 * Turn the Dispatch Harness agent type on or off. This is the only way to
 * make `dispatch` creatable: it is never a member of the enabled agent
 * types, and `setEnabledAgentTypesViaAPI` answers 400 for a body naming it.
 */
export async function setDispatchHarnessViaAPI(
  request: APIRequestContext,
  enabled: boolean
): Promise<void> {
  const res = await request.post(`${API}/app/settings/dispatch-harness`, {
    headers: authHeaders(),
    data: { enabled },
  });

  if (!res.ok()) {
    throw new Error(
      `Failed to update the Dispatch Harness setting: ${res.status()}`
    );
  }
}
```

- [ ] **Step 4: Point the four harness setups at the new endpoint**

In `e2e/harness-agent.spec.ts`, extend the import at lines 7-14 to:

```ts
import {
  authHeaders,
  cleanupE2EAgents,
  clickAgentRow,
  createAgentViaAPI,
  loadApp,
  setDispatchHarnessViaAPI,
  setEnabledAgentTypesViaAPI,
} from "./helpers";
```

Replace the setup at lines 102-106:

```ts
await setEnabledAgentTypesViaAPI(request, ["claude", "codex", "dispatch"]);
```

with:

```ts
await setEnabledAgentTypesViaAPI(request, ["claude", "codex"]);
await setDispatchHarnessViaAPI(request, true);
```

Then replace each of the three remaining single-line setups at lines 193, 262 and 338:

```ts
await setEnabledAgentTypesViaAPI(request, ["claude", "codex", "dispatch"]);
```

with:

```ts
await setEnabledAgentTypesViaAPI(request, ["claude", "codex"]);
await setDispatchHarnessViaAPI(request, true);
```

- [ ] **Step 5: Fix the serial-list comment**

In `playwright.config.ts`, replace line 32:

```ts
// Also flips the chat surface flag, and enables the dispatch agent type.
```

with:

```ts
// Also flips the chat surface flag and the Dispatch Harness flag.
```

- [ ] **Step 6: Prove no spec asks the agent-types endpoint for the harness**

Run: `cd /home/nii/.dispatch/server-dsh-harness && grep -rn "dispatch" e2e/*.spec.ts | grep setEnabledAgentTypesViaAPI`

Expected: no output, exit 1.

- [ ] **Step 7: Run the Settings spec, then the whole suite**

Run: `cd /home/nii/.dispatch/server-dsh-harness && bash scripts/e2e-isolated.sh e2e/settings.spec.ts`

Expected: PASS, 0 failed.

Run: `cd /home/nii/.dispatch/server-dsh-harness && pnpm run test:e2e`

Expected: PASS, 0 failed.

- [ ] **Step 8: Run the live harness spec**

Run: `cd /home/nii/.dispatch/server-dsh-harness && pnpm run test:e2e:live`

Expected: PASS, 0 failed. This is the only run that exercises the four retargeted setups, because `harness-agent.spec.ts` needs `DISPATCH_AGENT_RUNTIME=tmux`. If the fake ACP engine cannot start in this environment, report that plainly with the output rather than recording the task as green.

- [ ] **Step 9: Type check**

Run: `cd /home/nii/.dispatch/server-dsh-harness && pnpm run check`

Expected: exit 0, no `error TS` lines.

- [ ] **Step 10: Commit**

```bash
cd /home/nii/.dispatch/server-dsh-harness
git add e2e/helpers.ts e2e/harness-agent.spec.ts e2e/settings.spec.ts playwright.config.ts
git commit -m "$(cat <<'EOF'
test(e2e): turn the harness on through its own endpoint

The four harness setups enabled the type through the agent-types
endpoint, which now answers 400 for a body naming it, so every one of
them would have thrown before its first assertion. Add a helper for the
flag and cover the Settings card in the default suite.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**1. Spec coverage.** Section 2 of `docs/superpowers/specs/2026-09-08-harness-turns-in-chat-feed-design.md`, row by row:

| Spec requirement                                                                                                                                                                   | Task                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Settings key `dispatch_harness_enabled` in a new `apps/server/src/dispatch-harness-settings.ts`                                                                                    | 1                                                                                              |
| `GET`/`POST /api/v1/app/settings/dispatch-harness`, same shape, same `400` on a non-boolean                                                                                        | 1                                                                                              |
| No migration; an install with no row reads `false`                                                                                                                                 | 1 (the module's doc comment and its first test)                                                |
| `useDispatchHarnessEnabled` over `useServerFlag`                                                                                                                                   | 8                                                                                              |
| `dispatchHarnessEnabledHintAtom`, same `atomWithLocalStorage`                                                                                                                      | 8                                                                                              |
| `DispatchHarnessSettings`, label "Dispatch Harness (beta)", testid `dispatch-harness-toggle`, one sentence on running agents, no agent list, mounted next to the chat-surface card | 9                                                                                              |
| `sanitizeEnabledAgentTypes` drops `dispatch` on read and on write                                                                                                                  | 2                                                                                              |
| `POST /api/v1/app/settings/agent-types` answers `400` naming the harness endpoint                                                                                                  | 2                                                                                              |
| The Settings checkbox list stops offering it; its description moves to the new card                                                                                                | 9                                                                                              |
| `getOfferedAgentTypes(pool)` in `apps/server/src/agent-type-settings.ts`                                                                                                           | 3                                                                                              |
| Every gate reads the offered list: create route, `dispatch_launch_agent`, persona launches, plugin routes, release readiness                                                       | 4, 5, 6                                                                                        |
| `DEFAULT_ENABLED_AGENT_TYPES` needs no data change; its comment moves onto the flag                                                                                                | 2                                                                                              |
| `setEnabledAgentTypesViaAPI` keeps its signature and route; its non-ok throw is the loud failure                                                                                   | 11 (stated, not changed)                                                                       |
| `setDispatchHarnessViaAPI(request, enabled)`, and the four `harness-agent.spec.ts` calls                                                                                           | 11                                                                                             |
| Section 7's flag tests: two routes, `getOfferedAgentTypes` on and off, the agent-types `400`, a web test that the card writes through the query the routing reads                  | 1, 3, 2, 8 and 9                                                                               |
| Section 8's row: the flag off while dispatch agents run stops only creation and discovery                                                                                          | 1 (the module doc), and enforced by nothing in this plan touching `/harness/*` or pane routing |

Gaps found and closed while writing: `lifecycle-routes.ts:45` is a gate the spec's list omits, and it is now Task 4 with its reasoning recorded above. Two existing tests in `apps/server/test/agents-routes.test.ts` and one in `apps/server/test/release-routes.test.ts` enabled `dispatch` through the settings row and had to move to the flag; the mock factories in `apps/server/test/mcp-handlers.test.ts` and `apps/server/test/mcp-review-handlers.test.ts` had to gain the new export or the handlers would import `undefined`. All are in the tasks that cause them.

Two additions beyond the spec's list, both flagged where they appear: `useServerFlagSetting` (Task 7) so the second flag does not copy 60 lines of optimistic-write machinery, and the Settings e2e case (Task 11) so the new routes and card have coverage in the default `pnpm run test:e2e`, which never runs `harness-agent.spec.ts`.

Out of scope and untouched, confirmed by grep: `turn` entries, `chat/feed.ts`, `HarnessPane`, `ChatPane`, `agentSupportsHarness` (`apps/web/src/lib/center-tabs.ts:95`), `harnessEnabled` (`apps/web/src/components/app/agents-view.tsx:610`), and the dispatch-agent pane forcing at `agents-view.tsx:250`.

**2. Placeholder scan.** No "TBD", no "similar to Task N", no "add error handling". Every code step carries the code, every command its expected output. The one step that is not red-first is Task 6 Step 2, which says so and says why.

**3. Type consistency.** `getOfferedAgentTypes(pool: Pool): Promise<AgentType[]>` is the name used in Tasks 3, 4, 5 and 6 and in both mock factories. `offeredAgentTypes(enabledAgentTypes, dispatchHarnessEnabled)` is the web helper in Task 10, and `offeredAgentTypes` is also the context field name; the local in `App.tsx` is `offered` so the two never shadow. `ServerFlagSetting` is produced in Task 7 and consumed by name in Tasks 8 and 9. `useDispatchHarnessSetting` is what the card calls; `useDispatchHarnessEnabled` is what routing and `App.tsx` call. The card's testid is `dispatch-harness-toggle` in Tasks 9 and 11. The `400` body for a `dispatch` agent-types POST is the same string in Task 2's route and Task 2's test.
