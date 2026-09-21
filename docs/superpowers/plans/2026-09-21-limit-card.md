# Limit Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a provider runs out of tokens, show one card on the turn that says which provider, what kind of limit, and when it resets, with a button that resumes the work by itself at the reset time.

**Architecture:** A pure classifier turns a failed turn's error string into structured `limit` data, stored on the turn row's `jsonb` payload. The feed projection carries it to the web and drops the duplicate error text. A scheduled resume is one row per agent in a new table, fired by an in-process scheduler that reloads at boot. The web renders a card from the structured data and never parses an error string.

**Tech Stack:** TypeScript, Bun, Fastify, PostgreSQL (`node-pg-migrate` SQL files), Vitest, React, TanStack Query, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-21-provider-switch-and-limit-card-design.md`, sections 1 and 2. This is build step 1 of 3. Steps 2 and 3 have their own plans: `2026-09-21-provider-switch.md` and `2026-09-21-handoff-compression.md`.

## Global Constraints

- Setting `harness_limit_card_enabled`, default on. Unset reads as on; an explicit `"false"` is honoured. Follow `apps/server/src/subtask-model-settings.ts`.
- A scheduled resume gets **one** attempt. It never reschedules itself. An agent must never loop against a limit.
- No part of the UI parses an error string. The web reads `entry.limit` only.
- If no source yields a reset time, `resetsAt` is absent and the card says so. Never guess a time.
- Reset time sources, best first: the provider plan report (`plan_report`), then the error text (`error_text`).
- The resume prompt is a `--- DISPATCH: LIMIT RESET ---` system block, not a fake user message.
- Any message from the user, Cancel, Stop here, and (in plan 2) a provider switch each delete the scheduled resume.
- The "Switch provider" button is **not rendered** in this plan. Plan 2 adds it.
- No em-dashes in prose, comments, or commit messages. American spelling. Conventional commits, lowercase subject after the colon.
- Web unit tests on Node 25 need `NODE_OPTIONS=--no-experimental-webstorage`.
- Run server tests with `pnpm --filter @dispatch/server test -- <file>` from the repo root. Running `scripts/server-tests-isolated.sh` from the root globs the whole repo under the wrong config.

## File Structure

| File                                                             | Responsibility                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/shared/src/harness-types.ts`                           | `HarnessLimit`, `HarnessLimitKind`, `HarnessLimitResume` wire types                         |
| `apps/server/src/agents/harness/limit.ts`                        | Pure: classify an error, parse a reset time from text, pick a reset time from a plan report |
| `apps/server/src/harness-limit-settings.ts`                      | The `harness_limit_card_enabled` setting                                                    |
| `apps/server/src/agents/harness/stream-store.ts`                 | `TurnPayload.limit`                                                                         |
| `apps/server/src/agents/harness/stream-recorder.ts`              | Asks a `limitOf` dep about a failed turn, stores the answer                                 |
| `apps/server/src/chat/turns.ts`                                  | Carries `limit` onto the feed entry, drops the duplicate error text                         |
| `apps/server/src/db/migrations/0059_agent-scheduled-resumes.sql` | The table                                                                                   |
| `apps/server/src/agents/harness/limit-resume.ts`                 | Store and scheduler for scheduled resumes                                                   |
| `apps/server/src/routes/agents/harness-routes.ts`                | `POST` and `DELETE /harness/limit-resume`; queue response carries the schedule              |
| `apps/web/src/components/app/chat/turn/limit-card.tsx`           | The card                                                                                    |
| `apps/web/src/components/app/chat/chat-feed.tsx`                 | Tells a turn whether it is the agent's newest                                               |
| `apps/web/src/components/app/harness/use-limit-resume.ts`        | Schedule and cancel mutations                                                               |

---

### Task 1: Classify a limit and parse its reset time

**Files:**

- Modify: `packages/shared/src/harness-types.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `apps/server/src/agents/harness/limit.ts`
- Test: `apps/server/test/harness-limit.test.ts`

**Interfaces:**

- Produces: `HarnessLimitKind`, `HarnessLimit` (shared). `classifyLimit(error): { kind: HarnessLimitKind } | null`. `parseResetFromText(error, now): Date | null`. `resetFromPlanReport(plan, kind, now): Date | null`. `resolveLimit(input): HarnessLimit | null`.

- [ ] **Step 1: Add the shared types**

In `packages/shared/src/harness-types.ts`, after `HarnessEditTurnRequest`:

```ts
export type HarnessLimitKind = "session" | "weekly" | "usage" | "unknown";

/**
 * A turn that failed because the provider ran out of allowance. Structured at
 * the source so no reader ever parses the provider's error wording.
 */
export type HarnessLimit = {
  engine: HarnessEngineId;
  kind: HarnessLimitKind;
  /** ISO 8601. Absent when no source could say; never a guess. */
  resetsAt?: string;
  /** Where `resetsAt` came from, so a wrong time can be traced. */
  resetSource?: "plan_report" | "error_text";
};

/** A resume Dispatch will send by itself once a limit has reset. */
export type HarnessLimitResume = { resumeAt: string };
```

In `packages/shared/src/index.ts`, add `HarnessLimit`, `HarnessLimitKind` and `HarnessLimitResume` to the existing `harness-types` type export list, alphabetically beside `HarnessEditTurnRequest`.

- [ ] **Step 2: Write the failing tests**

Create `apps/server/test/harness-limit.test.ts`. The error strings are real rows from `agent_stream_events` on 2026-09-20.

```ts
import { describe, expect, it } from "vitest";
import type { HarnessProviderPlan } from "@dispatch/shared";

import {
  classifyLimit,
  parseResetFromText,
  resetFromPlanReport,
  resolveLimit,
} from "../src/agents/harness/limit.js";

const CLAUDE = `Internal error: You've hit your session limit · resets 5:30pm (America/Los_Angeles): {"errorKind":"rate_limit"}`;
const CLAUDE_2AM = `Internal error: You've hit your session limit · resets 2am (America/Los_Angeles): {"errorKind":"rate_limit"}`;
const CODEX = `Internal error: {"message":"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 20th, 2026 11:51 PM.","codexErrorInfo":"usageLimitExceeded"}`;
const CODEX_OLD = `Internal error: turn failed: You have hit your ChatGPT usage limit (plus plan). Try again in ~242 min.`;
const CODEX_NO_TIME = `Internal error: turn failed: Codex error: The usage limit has been reached`;

// 4:13 PM in Los Angeles.
const NOW = new Date("2026-09-20T23:13:00.000Z");

describe("classifyLimit", () => {
  it("reads each provider's limit, by code first and phrase second", () => {
    expect(classifyLimit(CLAUDE)).toEqual({ kind: "session" });
    expect(classifyLimit(CODEX)).toEqual({ kind: "usage" });
    expect(classifyLimit(CODEX_OLD)).toEqual({ kind: "usage" });
    expect(classifyLimit(CODEX_NO_TIME)).toEqual({ kind: "usage" });
  });

  it("names a weekly limit", () => {
    expect(
      classifyLimit(
        `Internal error: You've hit your weekly limit · resets 3pm (America/Los_Angeles): {"errorKind":"rate_limit"}`
      )
    ).toEqual({ kind: "weekly" });
  });

  it("does not mistake other failures, or prose about limits, for a limit", () => {
    expect(
      classifyLimit(
        "Invalid params: unknown session: 91166586-891d-429a-9939-0642c7969f1c"
      )
    ).toBeNull();
    // An agent's own words, stored as an assistant row on this host.
    expect(
      classifyLimit(
        "Now let me pin down Printful's actual documented rate limit from the official docs."
      )
    ).toBeNull();
    expect(classifyLimit("")).toBeNull();
    expect(classifyLimit(null)).toBeNull();
  });
});

describe("parseResetFromText", () => {
  it("reads Claude's time of day in the zone it names", () => {
    expect(parseResetFromText(CLAUDE, NOW)?.toISOString()).toBe(
      "2026-09-21T00:30:00.000Z"
    );
  });

  it("rolls a time that has already passed today to tomorrow", () => {
    expect(parseResetFromText(CLAUDE_2AM, NOW)?.toISOString()).toBe(
      "2026-09-21T09:00:00.000Z"
    );
  });

  it("reads Codex's relative form", () => {
    expect(parseResetFromText(CODEX_OLD, NOW)?.toISOString()).toBe(
      "2026-09-21T03:15:00.000Z"
    );
  });

  it("reads Codex's absolute date in the server's own zone", () => {
    const at = parseResetFromText(CODEX, NOW);
    expect(at).not.toBeNull();
    // No zone in the text, so assert the wall clock, not the instant.
    expect(at?.getFullYear()).toBe(2026);
    expect(at?.getMonth()).toBe(8);
    expect(at?.getDate()).toBe(20);
    expect(at?.getHours()).toBe(23);
    expect(at?.getMinutes()).toBe(51);
  });

  it("is null when the text gives no time, or names an unknown zone", () => {
    expect(parseResetFromText(CODEX_NO_TIME, NOW)).toBeNull();
    expect(parseResetFromText("resets 5pm (Not/AZone)", NOW)).toBeNull();
  });
});

describe("resetFromPlanReport", () => {
  const plan = (
    windows: HarnessProviderPlan["windows"]
  ): HarnessProviderPlan => ({
    engineId: "claude",
    plan: null,
    observedAt: NOW.toISOString(),
    windows,
  });

  it("uses the window the limit names", () => {
    const report = plan([
      {
        id: "session",
        label: "5-hour",
        usedPercent: 100,
        resetsAt: "2026-09-21T00:30:00.000Z",
      },
      {
        id: "weekly_all",
        label: "Weekly",
        usedPercent: 40,
        resetsAt: "2026-09-25T22:00:00.000Z",
      },
    ]);
    expect(resetFromPlanReport(report, "session", NOW)?.toISOString()).toBe(
      "2026-09-21T00:30:00.000Z"
    );
    expect(resetFromPlanReport(report, "weekly", NOW)?.toISOString()).toBe(
      "2026-09-25T22:00:00.000Z"
    );
  });

  it("falls back to the most exhausted window for a limit it cannot name", () => {
    const report = plan([
      {
        id: "primary",
        label: "Primary limit",
        usedPercent: 100,
        resetsAt: "2026-09-21T06:51:00.000Z",
      },
      {
        id: "secondary",
        label: "Secondary limit",
        usedPercent: 30,
        resetsAt: "2026-09-27T00:00:00.000Z",
      },
    ]);
    expect(resetFromPlanReport(report, "usage", NOW)?.toISOString()).toBe(
      "2026-09-21T06:51:00.000Z"
    );
  });

  it("ignores a reset time already in the past, and a window that is not full", () => {
    expect(
      resetFromPlanReport(
        plan([
          {
            id: "session",
            label: "5-hour",
            usedPercent: 100,
            resetsAt: "2026-09-08T23:40:00.000Z",
          },
        ]),
        "session",
        NOW
      )
    ).toBeNull();
    expect(
      resetFromPlanReport(
        plan([
          {
            id: "primary",
            label: "Primary limit",
            usedPercent: 12,
            resetsAt: "2026-09-21T06:51:00.000Z",
          },
        ]),
        "usage",
        NOW
      )
    ).toBeNull();
    expect(resetFromPlanReport(null, "session", NOW)).toBeNull();
  });
});

describe("resolveLimit", () => {
  it("prefers the plan report and records where the time came from", () => {
    const limit = resolveLimit({
      engine: "claude",
      error: CLAUDE,
      now: NOW,
      plan: {
        engineId: "claude",
        plan: null,
        observedAt: NOW.toISOString(),
        windows: [
          {
            id: "session",
            label: "5-hour",
            usedPercent: 100,
            resetsAt: "2026-09-21T00:31:12.000Z",
          },
        ],
      },
    });
    expect(limit).toEqual({
      engine: "claude",
      kind: "session",
      resetsAt: "2026-09-21T00:31:12.000Z",
      resetSource: "plan_report",
    });
  });

  it("falls back to the error text", () => {
    expect(
      resolveLimit({ engine: "claude", error: CLAUDE, now: NOW, plan: null })
    ).toEqual({
      engine: "claude",
      kind: "session",
      resetsAt: "2026-09-21T00:30:00.000Z",
      resetSource: "error_text",
    });
  });

  it("carries no time at all when neither source has one", () => {
    expect(
      resolveLimit({
        engine: "codex",
        error: CODEX_NO_TIME,
        now: NOW,
        plan: null,
      })
    ).toEqual({ engine: "codex", kind: "usage" });
  });

  it("is null for a failure that is not a limit", () => {
    expect(
      resolveLimit({ engine: "codex", error: "boom", now: NOW, plan: null })
    ).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `TZ=America/Los_Angeles pnpm --filter @dispatch/server test -- test/harness-limit.test.ts`
Expected: FAIL, cannot resolve `../src/agents/harness/limit.js`.

- [ ] **Step 4: Write the implementation**

Create `apps/server/src/agents/harness/limit.ts`. The classifier and parser below were run against every string in the test file before this plan was written.

```ts
import type {
  HarnessEngineId,
  HarnessLimit,
  HarnessLimitKind,
  HarnessProviderPlan,
} from "@dispatch/shared";

/**
 * A provider's own code for "out of allowance". Trusted before any phrase:
 * wording changes between releases and a code does not. `kind: null` means
 * the code says it is a limit and the text says which one.
 */
const CODE_PATTERNS: { re: RegExp; kind: HarnessLimitKind | null }[] = [
  { re: /"errorKind"\s*:\s*"rate_limit"/, kind: null },
  { re: /"codexErrorInfo"\s*:\s*"usageLimitExceeded"/, kind: "usage" },
];

/**
 * For an engine, or an older release, that sends no code. Anchored on the
 * provider's own sentence, not on the words "rate limit": an agent researching
 * someone's API rate limits writes those words in an ordinary failure.
 */
const PHRASE_PATTERNS: RegExp[] = [
  /you(?:'ve| have) hit your (?:\w+ )*?(?:usage |session |weekly )?limit/i,
  /the usage limit has been reached/i,
];

export function classifyLimit(
  error: string | null | undefined
): { kind: HarnessLimitKind } | null {
  if (!error) return null;
  const coded = CODE_PATTERNS.find((p) => p.re.test(error));
  const phrased = PHRASE_PATTERNS.some((re) => re.test(error));
  if (!coded && !phrased) return null;
  if (coded?.kind) return { kind: coded.kind };
  if (/weekly limit/i.test(error)) return { kind: "weekly" };
  if (/session limit/i.test(error)) return { kind: "session" };
  if (/usage limit/i.test(error)) return { kind: "usage" };
  return { kind: "unknown" };
}

type WallFields = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function partsIn(instant: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const out: Record<string, number> = {};
  for (const part of parts) out[part.type] = Number(part.value);
  return out;
}

/** The instant at which a wall clock in `timeZone` reads the given fields. */
function zonedWallTimeToUtc(fields: WallFields, timeZone: string): Date {
  const asUtc = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute
  );
  const offsetAt = (instant: number): number => {
    const p = partsIn(new Date(instant), timeZone);
    return (
      Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant
    );
  };
  // Two passes: the offset at the guess can differ from the offset at the
  // answer when a daylight-saving change falls between them.
  let guess = asUtc - offsetAt(asUtc);
  guess = asUtc - offsetAt(guess);
  return new Date(guess);
}

function to24h(hour: number, meridiem: string): number {
  return (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/**
 * The reset time as the provider worded it. Three forms have been seen:
 * Claude's time of day with a zone, Codex's absolute date with none, and an
 * older Codex duration. Null for any other wording: a wrong time is worse
 * than none, because a resume is scheduled against it.
 */
export function parseResetFromText(error: string, now: Date): Date | null {
  const claude =
    /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(error);
  if (claude) {
    const [, h, m, meridiem, timeZone] = claude;
    try {
      const today = partsIn(now, timeZone);
      const at = (day: Record<string, number>): Date =>
        zonedWallTimeToUtc(
          {
            year: day.year,
            month: day.month,
            day: day.day,
            hour: to24h(Number(h), meridiem),
            minute: Number(m ?? 0),
          },
          timeZone
        );
      const sameDay = at(today);
      if (sameDay.getTime() > now.getTime()) return sameDay;
      return at(partsIn(new Date(now.getTime() + 24 * 3_600_000), timeZone));
    } catch {
      // Intl throws a RangeError for a zone name it does not know.
      return null;
    }
  }
  const codex =
    /try again at\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(
      error
    );
  if (codex) {
    const [, mon, d, y, h, m, meridiem] = codex;
    const month = MONTHS.indexOf(mon.toLowerCase());
    if (month < 0) return null;
    // Codex names no zone. It runs on this host, so its clock is this one.
    return new Date(
      Number(y),
      month,
      Number(d),
      to24h(Number(h), meridiem),
      Number(m)
    );
  }
  const relative = /try again in\s*~?\s*(\d+)\s*min/i.exec(error);
  if (relative) return new Date(now.getTime() + Number(relative[1]) * 60_000);
  return null;
}

/** A window this full is the one that tripped. Providers round, so not 100. */
const EXHAUSTED_PERCENT = 95;

/** Which plan-report window a named limit corresponds to. */
const WINDOW_FOR_KIND: Partial<Record<HarnessLimitKind, string>> = {
  session: "session",
  weekly: "weekly_all",
};

/**
 * The reset time from the provider's plan report, which carries an exact
 * timestamp where the error text carries a rounded wall clock. Only a window
 * that is actually exhausted and resets in the future counts: a stale report
 * (see the macOS Keychain fix) names times already past.
 */
export function resetFromPlanReport(
  plan: HarnessProviderPlan | null,
  kind: HarnessLimitKind,
  now: Date
): Date | null {
  if (!plan) return null;
  const usable = plan.windows.filter((w) => {
    if (!w.resetsAt || w.usedPercent < EXHAUSTED_PERCENT) return false;
    const at = Date.parse(w.resetsAt);
    return Number.isFinite(at) && at > now.getTime();
  });
  if (usable.length === 0) return null;
  const named = WINDOW_FOR_KIND[kind];
  const match =
    (named ? usable.find((w) => w.id === named) : undefined) ??
    [...usable].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  return match?.resetsAt ? new Date(match.resetsAt) : null;
}

export function resolveLimit(input: {
  engine: HarnessEngineId;
  error: string | null | undefined;
  now: Date;
  plan: HarnessProviderPlan | null;
}): HarnessLimit | null {
  const classified = classifyLimit(input.error);
  if (!classified) return null;
  const base = { engine: input.engine, kind: classified.kind };
  const fromPlan = resetFromPlanReport(input.plan, classified.kind, input.now);
  if (fromPlan) {
    return {
      ...base,
      resetsAt: fromPlan.toISOString(),
      resetSource: "plan_report",
    };
  }
  const fromText = parseResetFromText(input.error ?? "", input.now);
  if (fromText) {
    return {
      ...base,
      resetsAt: fromText.toISOString(),
      resetSource: "error_text",
    };
  }
  return base;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `TZ=America/Los_Angeles pnpm --filter @dispatch/server test -- test/harness-limit.test.ts`
Expected: PASS, 14 tests.

Then run it once more with `TZ=UTC`. Every test must still pass: only the Codex absolute-date test depends on the zone, and it asserts the wall clock for that reason.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/harness-types.ts packages/shared/src/index.ts \
  apps/server/src/agents/harness/limit.ts apps/server/test/harness-limit.test.ts
git commit -m "feat(harness): recognize a provider limit from a failed turn's error"
```

---

### Task 2: Store the limit on the turn

**Files:**

- Create: `apps/server/src/harness-limit-settings.ts`
- Modify: `apps/server/src/agents/harness/stream-store.ts` (the `TurnPayload` type)
- Modify: `apps/server/src/agents/harness/stream-recorder.ts` (constructor deps; the `turn` settled branch of `handle`)
- Modify: `apps/server/src/agents/harness/supervisor.ts` (`SupervisorDeps`; where `StreamRecorder` is constructed)
- Modify: `apps/server/src/server.ts` (supervisor deps)
- Test: `apps/server/test/harness-stream-recorder.test.ts`

**Interfaces:**

- Consumes: `resolveLimit`, `HarnessLimit` from Task 1.
- Produces: `TurnPayload.limit?: HarnessLimit`. Recorder dep `limitOf?: (agentId: string, error: string) => Promise<HarnessLimit | null>`. `isHarnessLimitCardEnabled(pool): Promise<boolean>`. Supervisor dep `providerUsage?: () => Promise<HarnessProviderUsageReport>`.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/harness-stream-recorder.test.ts`:

```ts
describe("StreamRecorder provider limits", () => {
  const LIMIT_ERROR = `Internal error: You've hit your session limit · resets 5:30pm (America/Los_Angeles): {"errorKind":"rate_limit"}`;
  const turnPayload = async () =>
    (await store.list(A, 10)).find((r) => r.kind === "turn")?.payload as {
      error?: string;
      limit?: unknown;
    };

  it("stores what limitOf says beside the error", async () => {
    const limit = {
      engine: "claude",
      kind: "session",
      resetsAt: "2026-09-21T00:30:00.000Z",
      resetSource: "error_text",
    };
    const seen: string[] = [];
    const rec = new StreamRecorder(store, {
      limitOf: async (_agentId, error) => {
        seen.push(error);
        return limit as never;
      },
    });
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "go",
    });
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "settled",
      error: LIMIT_ERROR,
    });
    expect(seen).toEqual([LIMIT_ERROR]);
    expect(await turnPayload()).toMatchObject({ error: LIMIT_ERROR, limit });
  });

  it("stores no limit for an ordinary failure, and never asks about a clean turn", async () => {
    let asked = 0;
    const rec = new StreamRecorder(store, {
      limitOf: async () => {
        asked += 1;
        return null;
      },
    });
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "go",
    });
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "settled",
      error: "boom",
    });
    expect((await turnPayload()).limit).toBeUndefined();
    await pool.query("DELETE FROM agent_stream_events");
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "go",
    });
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "settled",
      stopReason: "end_turn",
    });
    expect(asked).toBe(1);
  });

  it("still settles the turn when limitOf throws", async () => {
    const rec = new StreamRecorder(store, {
      limitOf: async () => {
        throw new Error("usage report unavailable");
      },
    });
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "started",
      text: "go",
    });
    await rec.handle({
      type: "turn",
      agentId: A,
      state: "settled",
      error: LIMIT_ERROR,
    });
    expect(await turnPayload()).toMatchObject({
      state: "settled",
      error: LIMIT_ERROR,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @dispatch/server test -- test/harness-stream-recorder.test.ts`
Expected: FAIL on the first new test: `limit` is undefined, because the recorder ignores the `limitOf` option.

- [ ] **Step 3: Add the payload field**

In `apps/server/src/agents/harness/stream-store.ts`, add the import and the field:

```ts
import type { HarnessLimit } from "@dispatch/shared";
```

Inside `export type TurnPayload`, after `error?: string;`:

```ts
  /**
   * Set when `error` was the provider running out of allowance. Readers use
   * this and never parse `error`: see agents/harness/limit.ts.
   */
  limit?: HarnessLimit;
```

- [ ] **Step 4: Teach the recorder to ask**

In `apps/server/src/agents/harness/stream-recorder.ts`, add `HarnessLimit` to the imports from `@dispatch/shared`, then widen the constructor's `deps`:

```ts
    private readonly deps: {
      autonomousIdleMs?: number;
      onAutonomousSettled?: (agentId: string) => void;
      /**
       * Whether a failed turn's error was a provider limit. The recorder
       * knows neither the agent's engine nor the plan report, so its host
       * answers. Absent, or null, or throwing: no limit is recorded.
       */
      limitOf?: (agentId: string, error: string) => Promise<HarnessLimit | null>;
    } = {}
```

In `handle`, in the `case "turn"` branch where a settled turn is written, replace:

```ts
        const open = this.openTurn.get(event.agentId);
        if (open) {
          const prev = open.payload as TurnPayload;
          await this.store.updatePayload(open.id, {
            ...prev,
            state: "settled",
            ...(event.stopReason ? { stopReason: event.stopReason } : {}),
            ...(event.error ? { error: event.error } : {}),
            endedAt: new Date().toISOString(),
          } satisfies TurnPayload);
```

with:

```ts
        const open = this.openTurn.get(event.agentId);
        if (open) {
          const prev = open.payload as TurnPayload;
          // A failed lookup must not leave the turn open: the limit is a
          // nicety on top of a settle that has to happen regardless.
          const limit = event.error
            ? await this.deps
                .limitOf?.(event.agentId, event.error)
                .catch(() => null)
            : null;
          await this.store.updatePayload(open.id, {
            ...prev,
            state: "settled",
            ...(event.stopReason ? { stopReason: event.stopReason } : {}),
            ...(event.error ? { error: event.error } : {}),
            ...(limit ? { limit } : {}),
            endedAt: new Date().toISOString(),
          } satisfies TurnPayload);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @dispatch/server test -- test/harness-stream-recorder.test.ts`
Expected: PASS, including the three new tests.

- [ ] **Step 6: Add the setting**

Create `apps/server/src/harness-limit-settings.ts`:

```ts
import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";

/**
 * Whether a turn that failed on a provider limit is recorded as one, which is
 * what shows the limit card and allows a scheduled resume. On by default.
 *
 * Off, a limit is an ordinary failed turn again: the raw error text and
 * nothing scheduled. Read when a turn fails, so a flip takes effect on the
 * next failure with no restart.
 *
 * Unset reads as on; an explicit `"false"` is honoured.
 */
const HARNESS_LIMIT_CARD_KEY = "harness_limit_card_enabled";

export async function isHarnessLimitCardEnabled(pool: Pool): Promise<boolean> {
  return (await getSetting(pool, HARNESS_LIMIT_CARD_KEY)) !== "false";
}

export async function setHarnessLimitCardEnabled(
  pool: Pool,
  enabled: boolean
): Promise<void> {
  await setSetting(pool, HARNESS_LIMIT_CARD_KEY, enabled ? "true" : "false");
}
```

- [ ] **Step 7: Wire the supervisor**

In `apps/server/src/agents/harness/supervisor.ts`, add to `SupervisorDeps`:

```ts
  /**
   * The provider plan report, for an exact reset time when a turn fails on a
   * limit. Optional: without it the time comes from the error text.
   */
  providerUsage?: () => Promise<HarnessProviderUsageReport>;
  /** Whether limits are recorded as limits (harness_limit_card_enabled). */
  limitCardEnabled?: () => Promise<boolean>;
```

Add `HarnessProviderUsageReport` to the `@dispatch/shared` type imports, and:

```ts
import { resolveLimit } from "./limit.js";
```

Find where the supervisor constructs its `StreamRecorder` (search for `new StreamRecorder(`). Add `limitOf` to the options object it already passes:

```ts
      limitOf: async (agentId, error) => {
        if (this.deps.limitCardEnabled && !(await this.deps.limitCardEnabled())) {
          return null;
        }
        const agent = await this.deps.getAgent(agentId);
        const engine = splitModelId(agent?.model ?? DEFAULT_HARNESS_MODEL).engine;
        // The report is best-effort: a provider that cannot be reached still
        // leaves the time in the error text.
        const report = await this.deps.providerUsage?.().catch(() => null);
        const plan =
          report?.providers.find((p) => p.engineId === engine) ?? null;
        return resolveLimit({ engine, error, now: new Date(), plan });
      },
```

`splitModelId` and `DEFAULT_HARNESS_MODEL` are already imported in this file.

In `apps/server/src/server.ts`, in the object passed to `new HarnessSupervisor({ ... })`, add:

```ts
    providerUsage: () => harnessProviderUsageReport(),
    limitCardEnabled: () => isHarnessLimitCardEnabled(pool),
```

and the import:

```ts
import { isHarnessLimitCardEnabled } from "./harness-limit-settings.js";
```

`harnessProviderUsageReport` is declared lower in `server.ts` than the supervisor. Move its `createHarnessProviderUsageReporter({...})` declaration above the supervisor's construction. It depends only on `app.log`, which exists by then.

- [ ] **Step 8: Typecheck and run the supervisor suite**

Run: `pnpm --filter @dispatch/server check && pnpm --filter @dispatch/server test -- test/harness-supervisor.test.ts`
Expected: no type errors; PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/harness-limit-settings.ts \
  apps/server/src/agents/harness/stream-store.ts \
  apps/server/src/agents/harness/stream-recorder.ts \
  apps/server/src/agents/harness/supervisor.ts apps/server/src/server.ts \
  apps/server/test/harness-stream-recorder.test.ts
git commit -m "feat(harness): store a provider limit on the turn it ended"
```

---

### Task 3: Carry the limit to the feed, once

**Files:**

- Modify: `packages/shared/src/chat-types.ts` (the `ChatTurnEntry` type)
- Modify: `apps/server/src/chat/turns.ts` (`AssembledTurn`, `assembleTurns`, `toTurnEntry`)
- Test: `apps/server/test/chat-turns.test.ts`

**Interfaces:**

- Consumes: `TurnPayload.limit` from Task 2.
- Produces: `ChatTurnEntry.limit?: HarnessLimit`. When set, `entry.error` is absent and a result that only repeats the limit sentence is absent too.

A limit lands three times today: the engine's reply ("You've hit your session limit · resets 5:30pm"), a `status` row, and the turn's `error`. The `status` row is not projected into turns. This task removes the other two when `limit` is set, so the card is the only place it shows.

- [ ] **Step 1: Write the failing test**

Append to the `describe("toTurnEntry", ...)` block in `apps/server/test/chat-turns.test.ts`:

```ts
it("carries a provider limit and drops the text that only repeats it", () => {
  seq = 0;
  const limit = {
    engine: "claude",
    kind: "session",
    resetsAt: "2026-09-21T00:30:00.000Z",
    resetSource: "error_text",
  };
  const rows: TurnSourceRow[] = [
    row(
      "turn",
      {
        state: "settled",
        prompt: { source: "system", text: "p" },
        error: `Internal error: You've hit your session limit · resets 5:30pm (America/Los_Angeles): {"errorKind":"rate_limit"}`,
        limit,
        endedAt: at(3).toISOString(),
      },
      0,
      3
    ),
    row(
      "assistant",
      {
        text: "You've hit your session limit · resets 5:30pm (America/Los_Angeles)",
        streaming: false,
      },
      2
    ),
  ];
  const groups = groupTurnRows(rows);
  const [turn] = assembleTurns(rows, new Map());
  const entry = toTurnEntry(turn, groups[0], "a");
  expect(entry.limit).toEqual(limit);
  expect(entry.error).toBeUndefined();
  expect(entry.result).toBeNull();
  expect(entry.trace.finalResult).toBe("error");
});

it("keeps a real answer that came before the limit", () => {
  seq = 0;
  const rows: TurnSourceRow[] = [
    row(
      "turn",
      {
        state: "settled",
        prompt: { source: "system", text: "p" },
        error: `Internal error: {"codexErrorInfo":"usageLimitExceeded"}`,
        limit: { engine: "codex", kind: "usage" },
        endedAt: at(3).toISOString(),
      },
      0,
      3
    ),
    row(
      "assistant",
      { text: "I finished the first half.", streaming: false },
      2
    ),
  ];
  const groups = groupTurnRows(rows);
  const [turn] = assembleTurns(rows, new Map());
  const entry = toTurnEntry(turn, groups[0], "a");
  expect(entry.result?.text).toBe("I finished the first half.");
  expect(entry.error).toBeUndefined();
  expect(entry.limit).toEqual({ engine: "codex", kind: "usage" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @dispatch/server test -- test/chat-turns.test.ts`
Expected: FAIL, `entry.limit` is undefined.

- [ ] **Step 3: Add the wire field**

In `packages/shared/src/chat-types.ts`, import `HarnessLimit` from `./harness-types.js` with the file's other type imports, and add to `ChatTurnEntry` after `error?: string;`:

```ts
  /**
   * The turn failed on a provider limit. When set, `error` is absent and a
   * result that only repeated the limit is dropped: the card says it once.
   */
  limit?: HarnessLimit;
```

- [ ] **Step 4: Project it**

In `apps/server/src/chat/turns.ts`:

Add to the `AssembledTurn` type, beside `error`:

```ts
  limit?: HarnessLimit;
```

Import `HarnessLimit` from `@dispatch/shared` and `classifyLimit` from `../agents/harness/limit.js`.

In `assembleTurns`, where the returned object is built and `error` is read from `turnPayload`, add `limit` from the same payload:

```ts
const limit = turnPayload?.limit;
```

and include `...(limit ? { limit } : {})` in the returned turn, beside the existing `error` spread.

In `toTurnEntry`, replace:

```ts
const error = byRestart ? undefined : turn.error;
```

with:

```ts
// The card states a limit once. The turn's error repeats it with a JSON
// fragment on the end, and the engine's own reply often repeats it again:
// both go. A reply that says anything else is a real answer and stays.
const limit = turn.limit;
const error = byRestart || limit ? undefined : turn.error;
const result =
  limit && turn.result && classifyLimit(turn.result.text) !== null
    ? null
    : turn.result;
```

Then in the returned object use `result,` in place of `result: turn.result,`, and add after the `error` spread:

```ts
    ...(limit ? { limit } : {}),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @dispatch/server test -- test/chat-turns.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/chat-types.ts apps/server/src/chat/turns.ts \
  apps/server/test/chat-turns.test.ts
git commit -m "feat(chat): carry a provider limit to the feed and say it once"
```

---

### Task 4: Schedule a resume that survives a restart

**Files:**

- Create: `apps/server/src/db/migrations/0059_agent-scheduled-resumes.sql`
- Create: `apps/server/src/agents/harness/limit-resume.ts`
- Test: `apps/server/test/harness-limit-resume.test.ts`

**Interfaces:**

- Produces: `LIMIT_RESET_PROMPT: string`. `class LimitResumeScheduler` with `schedule(agentId, turnId, resumeAt: Date): Promise<void>`, `cancel(agentId): Promise<boolean>`, `get(agentId): Promise<Date | null>`, `loadPending(): Promise<number>`, `stop(): void`.

- [ ] **Step 1: Write the migration**

Create `apps/server/src/db/migrations/0059_agent-scheduled-resumes.sql`:

```sql
-- A resume Dispatch sends by itself once a provider limit has reset.
--
-- A row, not a timer: a server restart between the click and the reset time
-- must not lose it. One per agent, so scheduling again replaces the earlier
-- one. `turn_id` is the `agent_stream_events` row of the turn that hit the
-- limit, the same number the feed entry carries as `turn:<id>`, so a record of
-- which turn a resume was for survives the resume itself. No foreign key: a
-- turn row can be deleted by an edit, and the resume must not block that.
CREATE TABLE IF NOT EXISTS agent_scheduled_resumes (
  agent_id   text PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  turn_id    bigint NOT NULL,
  resume_at  timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Write the failing tests**

Create `apps/server/test/harness-limit-resume.test.ts`:

```ts
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Pool } from "pg";

import {
  LIMIT_RESET_PROMPT,
  LimitResumeScheduler,
} from "../src/agents/harness/limit-resume.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

let pool: Pool;
const A = "agt_resume_a";

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status) VALUES ($1, 'R', '/tmp', 'running')`,
    [A]
  );
});
afterAll(async () => {
  await teardownTestDb();
});
beforeEach(async () => {
  await pool.query("DELETE FROM agent_scheduled_resumes");
});

function build() {
  const sent: { agentId: string; text: string }[] = [];
  const changed: string[] = [];
  const scheduler = new LimitResumeScheduler({
    pool,
    sendPrompt: async (agentId, text) => {
      sent.push({ agentId, text });
    },
    onChanged: (agentId) => changed.push(agentId),
    logger: { warn: vi.fn() },
  });
  return { scheduler, sent, changed };
}

const soon = (ms: number) => new Date(Date.now() + ms);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("LimitResumeScheduler", () => {
  it("sends the reset prompt at the time, once, and clears the row", async () => {
    const { scheduler, sent, changed } = build();
    await scheduler.schedule(A, 7, soon(40));
    expect((await scheduler.get(A))?.getTime()).toBeGreaterThan(Date.now());
    expect(sent).toEqual([]);
    await wait(120);
    expect(sent).toEqual([{ agentId: A, text: LIMIT_RESET_PROMPT }]);
    expect(await scheduler.get(A)).toBeNull();
    // Scheduled, then fired: the card has to hear about both.
    expect(changed).toEqual([A, A]);
    await wait(80);
    expect(sent).toHaveLength(1);
    scheduler.stop();
  });

  it("does not send a cancelled resume", async () => {
    const { scheduler, sent } = build();
    await scheduler.schedule(A, 7, soon(40));
    expect(await scheduler.cancel(A)).toBe(true);
    expect(await scheduler.cancel(A)).toBe(false);
    await wait(120);
    expect(sent).toEqual([]);
    scheduler.stop();
  });

  it("replaces an earlier schedule instead of stacking a second send", async () => {
    const { scheduler, sent } = build();
    await scheduler.schedule(A, 7, soon(40));
    await scheduler.schedule(A, 7, soon(90));
    await wait(60);
    expect(sent).toEqual([]);
    await wait(90);
    expect(sent).toHaveLength(1);
    scheduler.stop();
  });

  it("reloads a pending resume after a restart, and fires one already past due", async () => {
    await pool.query(
      `INSERT INTO agent_scheduled_resumes (agent_id, turn_id, resume_at)
       VALUES ($1, 7, now() - interval '5 minutes')`,
      [A]
    );
    // A fresh scheduler is the process after a restart: no timers in memory.
    const { scheduler, sent } = build();
    expect(await scheduler.loadPending()).toBe(1);
    await wait(60);
    expect(sent).toEqual([{ agentId: A, text: LIMIT_RESET_PROMPT }]);
    scheduler.stop();
  });

  it("clears the row even when the send fails, so it cannot fire twice", async () => {
    const warn = vi.fn();
    const scheduler = new LimitResumeScheduler({
      pool,
      sendPrompt: async () => {
        throw new Error("agent is not running");
      },
      onChanged: () => {},
      logger: { warn },
    });
    await scheduler.schedule(A, 7, soon(30));
    await wait(100);
    expect(await scheduler.get(A)).toBeNull();
    expect(warn).toHaveBeenCalled();
    scheduler.stop();
  });

  it("refuses a time in the past", async () => {
    const { scheduler } = build();
    await expect(scheduler.schedule(A, 7, soon(-1000))).rejects.toThrow(
      "resumeAt must be in the future"
    );
    scheduler.stop();
  });
});

describe("LIMIT_RESET_PROMPT", () => {
  it("is a Dispatch notice block, so the feed shows it as one", () => {
    expect(LIMIT_RESET_PROMPT.startsWith("--- DISPATCH: LIMIT RESET ---")).toBe(
      true
    );
    expect(
      LIMIT_RESET_PROMPT.endsWith("--- END DISPATCH: LIMIT RESET ---")
    ).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @dispatch/server test -- test/harness-limit-resume.test.ts`
Expected: FAIL, cannot resolve `limit-resume.js`.

- [ ] **Step 4: Write the implementation**

Create `apps/server/src/agents/harness/limit-resume.ts`:

```ts
import type { Pool } from "pg";

/**
 * What Dispatch sends once a limit has reset. A notice block, so the feed
 * reads it as Dispatch speaking (see parseDispatchNotice in the web's
 * prompt-line.tsx) and not as something the user typed.
 */
export const LIMIT_RESET_PROMPT = [
  "--- DISPATCH: LIMIT RESET ---",
  "Your provider's usage limit has reset. Your previous turn ended early because the limit was reached; nothing else went wrong.",
  "Pick the task back up from where you left off: check the current state of anything you were changing, then continue.",
  "--- END DISPATCH: LIMIT RESET ---",
].join("\n");

/** setTimeout's delay is a 32-bit int; a longer wait is re-armed in hops. */
const MAX_TIMER_MS = 2_147_000_000;

export type LimitResumeDeps = {
  pool: Pool;
  /** Queue one system prompt for the agent (HarnessSupervisor.prompt). */
  sendPrompt: (agentId: string, text: string) => Promise<void>;
  /** Tell the agent's clients the schedule changed. */
  onChanged: (agentId: string) => void;
  logger: { warn: (fields: Record<string, unknown>, message: string) => void };
};

/**
 * Resumes an agent by itself once its provider limit has reset.
 *
 * The row is the schedule; the timer is only how this process notices the
 * time. `loadPending` rebuilds the timers at boot, so a restart between the
 * click and the reset loses nothing.
 *
 * One attempt. The row is deleted before the prompt is sent, so a send that
 * fails, or a resumed turn that meets the limit again, cannot fire a second
 * time. Rescheduling is the user's decision, made on the new limit card.
 */
export class LimitResumeScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: LimitResumeDeps) {}

  async schedule(
    agentId: string,
    turnId: number,
    resumeAt: Date
  ): Promise<void> {
    if (!(resumeAt.getTime() > Date.now())) {
      throw new Error("resumeAt must be in the future");
    }
    await this.deps.pool.query(
      `INSERT INTO agent_scheduled_resumes (agent_id, turn_id, resume_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_id)
       DO UPDATE SET turn_id = EXCLUDED.turn_id,
                     resume_at = EXCLUDED.resume_at,
                     created_at = now()`,
      [agentId, turnId, resumeAt.toISOString()]
    );
    this.arm(agentId, resumeAt);
    this.deps.onChanged(agentId);
  }

  /** True when there was a resume to cancel. */
  async cancel(agentId: string): Promise<boolean> {
    this.disarm(agentId);
    const result = await this.deps.pool.query(
      "DELETE FROM agent_scheduled_resumes WHERE agent_id = $1",
      [agentId]
    );
    const removed = (result.rowCount ?? 0) > 0;
    if (removed) this.deps.onChanged(agentId);
    return removed;
  }

  async get(agentId: string): Promise<Date | null> {
    const result = await this.deps.pool.query<{ resume_at: Date }>(
      "SELECT resume_at FROM agent_scheduled_resumes WHERE agent_id = $1",
      [agentId]
    );
    return result.rows[0]?.resume_at ?? null;
  }

  /** At boot: arm a timer for every stored resume. Returns how many. */
  async loadPending(): Promise<number> {
    const result = await this.deps.pool.query<{
      agent_id: string;
      resume_at: Date;
    }>("SELECT agent_id, resume_at FROM agent_scheduled_resumes");
    for (const row of result.rows) this.arm(row.agent_id, row.resume_at);
    return result.rows.length;
  }

  /** Drop every timer (shutdown, tests). The rows stay for the next boot. */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private disarm(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(agentId);
  }

  private arm(agentId: string, resumeAt: Date): void {
    this.disarm(agentId);
    const wait = Math.max(0, resumeAt.getTime() - Date.now());
    const timer = setTimeout(
      () => {
        this.timers.delete(agentId);
        if (resumeAt.getTime() - Date.now() > 0) {
          // A hop of a wait longer than one timer can hold.
          this.arm(agentId, resumeAt);
          return;
        }
        void this.fire(agentId);
      },
      Math.min(wait, MAX_TIMER_MS)
    );
    timer.unref?.();
    this.timers.set(agentId, timer);
  }

  private async fire(agentId: string): Promise<void> {
    // Delete first, and only send if this call was the one that deleted it:
    // a cancel that raced the timer wins, and nothing can send twice.
    const claimed = await this.deps.pool.query(
      "DELETE FROM agent_scheduled_resumes WHERE agent_id = $1",
      [agentId]
    );
    if ((claimed.rowCount ?? 0) === 0) return;
    this.deps.onChanged(agentId);
    try {
      await this.deps.sendPrompt(agentId, LIMIT_RESET_PROMPT);
    } catch (err) {
      this.deps.logger.warn(
        { err, agentId },
        "could not resume an agent after its provider limit reset"
      );
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @dispatch/server test -- test/harness-limit-resume.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/migrations/0059_agent-scheduled-resumes.sql \
  apps/server/src/agents/harness/limit-resume.ts \
  apps/server/test/harness-limit-resume.test.ts
git commit -m "feat(harness): resume an agent by itself once its limit resets"
```

---

### Task 5: Routes, wiring, and "the user took over"

**Files:**

- Modify: `packages/shared/src/harness-types.ts` (`HarnessQueueResponse`)
- Modify: `apps/server/src/routes/agents/shared.ts` (the `harness` dep type)
- Modify: `apps/server/src/routes/agents/harness-routes.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/chat/service.ts` (`sendUserMessage`)
- Test: `apps/server/test/harness-routes.test.ts`

**Interfaces:**

- Consumes: `LimitResumeScheduler` from Task 4.
- Produces: `HarnessQueueResponse.limitResume: HarnessLimitResume | null`. `POST /api/v1/agents/:id/harness/limit-resume` body `{ turnId: number; resumeAt: string }` returns `204`. `DELETE` on the same path returns `204`, or `404` when nothing was scheduled. Route deps `harness.limitResume: { schedule, cancel, get }`.

The schedule rides on the queue response because a scheduled resume is a prompt waiting to run, and the web already refetches the queue on every `harness.changed` event (`invalidateHarnessQueue` in `apps/web/src/hooks/use-sse.ts`). No new query and no new event.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/test/harness-routes.test.ts`:

```ts
describe("limit resume routes", () => {
  async function build(scheduled: Date | null = null) {
    const calls: string[] = [];
    let current = scheduled;
    const app = Fastify();
    await registerAgentHarnessRoutes(app, {
      pool: ctx.pool,
      appLog: app.log,
      chat: {} as never,
      harness: {
        getConfigOptions: () => null,
        getSessionStartedAt: () => null,
        setConfigOption: async () => [],
        getCommands: () => null,
        listQueued: () => [],
        sendQueuedNow: async () => false,
        removeQueued: () => false,
        interrupt: async () => false,
        runningPromptId: () => null,
        holdQueue: () => ({ release: () => {} }),
        interruptAndWait: async () => false,
        limitResume: {
          schedule: async (agentId: string, turnId: number, at: Date) => {
            calls.push(`schedule:${agentId}:${turnId}:${at.toISOString()}`);
            current = at;
          },
          cancel: async () => {
            const had = current !== null;
            current = null;
            calls.push("cancel");
            return had;
          },
          get: async () => current,
        },
      },
    });
    return { app, calls };
  }
  const future = () => new Date(Date.now() + 3_600_000).toISOString();

  it("schedules a resume and reports it on the queue", async () => {
    const { app, calls } = await build();
    const resumeAt = future();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/harness/limit-resume`,
      headers: { "content-type": "application/json" },
      payload: { turnId: 7, resumeAt },
    });
    expect(res.statusCode).toBe(204);
    expect(calls).toEqual([`schedule:${agentId}:7:${resumeAt}`]);
    const queue = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}/harness/queue`,
    });
    expect(queue.json().limitResume).toEqual({ resumeAt });
    await app.close();
  });

  it("reports no resume when none is scheduled", async () => {
    const { app } = await build();
    const queue = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agentId}/harness/queue`,
    });
    expect(queue.json().limitResume).toBeNull();
    await app.close();
  });

  it("rejects a bad body before scheduling anything", async () => {
    const { app, calls } = await build();
    const post = (payload: unknown) =>
      app.inject({
        method: "POST",
        url: `/api/v1/agents/${agentId}/harness/limit-resume`,
        headers: { "content-type": "application/json" },
        payload: payload as never,
      });
    expect((await post({ turnId: 7 })).statusCode).toBe(400);
    expect((await post({ turnId: 7, resumeAt: "not a date" })).statusCode).toBe(
      400
    );
    expect((await post({ turnId: "x", resumeAt: future() })).statusCode).toBe(
      400
    );
    expect(
      (await post({ turnId: 7, resumeAt: "2020-01-01T00:00:00.000Z" }))
        .statusCode
    ).toBe(400);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("cancels, and 404s when there was nothing to cancel", async () => {
    const { app } = await build(new Date(Date.now() + 3_600_000));
    const del = () =>
      app.inject({
        method: "DELETE",
        url: `/api/v1/agents/${agentId}/harness/limit-resume`,
      });
    expect((await del()).statusCode).toBe(204);
    expect((await del()).statusCode).toBe(404);
    await app.close();
  });
});
```

Also add `limitResume: { schedule: async () => {}, cancel: async () => false, get: async () => null },` to the `harness` stub in the two existing `registerAgentHarnessRoutes` calls in this file (the queue-shape test and the `turn/edit` `build`), so they satisfy the widened type.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @dispatch/server test -- test/harness-routes.test.ts`
Expected: FAIL with 404 on `POST .../limit-resume`.

- [ ] **Step 3: Widen the shared response and the dep type**

In `packages/shared/src/harness-types.ts`, replace:

```ts
export type HarnessQueueResponse = { queued: HarnessQueuedPrompt[] };
```

with:

```ts
export type HarnessQueueResponse = {
  queued: HarnessQueuedPrompt[];
  /** A resume Dispatch will send once a provider limit resets, or null. */
  limitResume: HarnessLimitResume | null;
};
```

Move the `HarnessLimitResume` declaration from Task 1 above this type so it is declared before use.

In `apps/server/src/routes/agents/shared.ts`, add to the `harness` dep object after `interruptAndWait`:

```ts
/** Scheduled resumes after a provider limit (LimitResumeScheduler). */
limitResume: {
  schedule: (agentId: string, turnId: number, resumeAt: Date) => Promise<void>;
  cancel: (agentId: string) => Promise<boolean>;
  get: (agentId: string) => Promise<Date | null>;
}
```

- [ ] **Step 4: Add the routes**

In `apps/server/src/routes/agents/harness-routes.ts`, in the existing `GET .../harness/queue` handler, build the response with the schedule. Find where the handler constructs its `HarnessQueueResponse` and add the field:

```ts
const resumeAt = await deps.harness.limitResume.get(id);
const response: HarnessQueueResponse = {
  queued,
  limitResume: resumeAt ? { resumeAt: resumeAt.toISOString() } : null,
};
return response;
```

Add the two routes after the `harness/interrupt` route:

```ts
/**
 * Resume this agent by itself once its provider limit has reset. One
 * resume per agent: scheduling again replaces the earlier one.
 */
app.post("/api/v1/agents/:id/harness/limit-resume", async (request, reply) => {
  const id = (request.params as { id?: string }).id ?? "";
  if (!(await exists(id))) {
    return reply.code(404).send({ error: "Agent not found." });
  }
  const body = (request.body ?? {}) as {
    turnId?: unknown;
    resumeAt?: unknown;
  };
  if (typeof body.turnId !== "number" || !Number.isInteger(body.turnId)) {
    return reply.code(400).send({ error: "turnId must be an integer." });
  }
  const at =
    typeof body.resumeAt === "string" ? Date.parse(body.resumeAt) : NaN;
  if (!Number.isFinite(at)) {
    return reply.code(400).send({ error: "resumeAt must be a date." });
  }
  if (at <= Date.now()) {
    return reply.code(400).send({ error: "resumeAt must be in the future." });
  }
  await deps.harness.limitResume.schedule(id, body.turnId, new Date(at));
  return reply.code(204).send();
});

app.delete(
  "/api/v1/agents/:id/harness/limit-resume",
  async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    if (!(await exists(id))) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    if (!(await deps.harness.limitResume.cancel(id))) {
      return reply.code(404).send({ error: "No resume is scheduled." });
    }
    return reply.code(204).send();
  }
);
```

- [ ] **Step 5: Wire it in `server.ts`**

After the `HarnessSupervisor` is constructed:

```ts
const limitResumeScheduler = new LimitResumeScheduler({
  pool,
  sendPrompt: (agentId, text) => harnessSupervisor.prompt(agentId, text),
  onChanged: (agentId) => chatService.publishHarnessChanged(agentId),
  logger: { warn: (fields, message) => app.log.warn(fields, message) },
});
```

Use the name `server.ts` already gives its `ChatService` instance if it is not `chatService`. Import:

```ts
import { LimitResumeScheduler } from "./agents/harness/limit-resume.js";
```

In the `harness:` object passed to `registerAgentRoutes`, after `interruptAndWait`:

```ts
      limitResume: {
        schedule: (agentId, turnId, resumeAt) =>
          limitResumeScheduler.schedule(agentId, turnId, resumeAt),
        cancel: (agentId) => limitResumeScheduler.cancel(agentId),
        get: (agentId) => limitResumeScheduler.get(agentId),
      },
```

Where the server restores harness agents at boot (search `restoreRunning()`), add after it, so a resume due now finds its agent running:

```ts
const pendingResumes = await limitResumeScheduler.loadPending();
if (pendingResumes > 0) {
  app.log.info({ pendingResumes }, "Reloaded scheduled limit resumes");
}
```

In the server's shutdown sequence, beside where the harness supervisor is stopped, add `limitResumeScheduler.stop();`.

- [ ] **Step 6: A message from the user cancels the resume**

The user typing means the user has taken over. In `apps/server/src/chat/service.ts`, add to `ChatServiceDeps` (the `deps` type of `ChatService`):

```ts
  /** The user sent a message: a scheduled limit resume no longer applies. */
  cancelLimitResume?: (agentId: string) => Promise<unknown>;
```

In `sendUserMessage`, immediately after the `await this.publishEntry(agentId, message.id);` line:

```ts
// The user is here and has said what happens next. A resume scheduled
// for later would land on top of whatever they just started.
await this.deps.cancelLimitResume?.(agentId).catch(() => {});
```

In `server.ts`, the `ChatService` is constructed before the scheduler exists, so pass a late-bound closure in the `ChatService` deps:

```ts
    cancelLimitResume: (agentId) =>
      limitResumeScheduler?.cancel(agentId) ?? Promise.resolve(false),
```

and declare `let limitResumeScheduler: LimitResumeScheduler | undefined;` above the `ChatService` construction, assigning it (without `const`) where Step 5 constructs it.

Add to `apps/server/test/chat-service.test.ts`, inside the top-level `describe` that covers `sendUserMessage`, using that file's existing service factory. If the factory does not accept extra deps, extend it with an optional `cancelLimitResume` parameter passed straight through:

```ts
it("cancels a scheduled limit resume when the user sends a message", async () => {
  const cancelled: string[] = [];
  const svc = makeService({
    cancelLimitResume: async (agentId: string) => {
      cancelled.push(agentId);
    },
  });
  await svc.sendUserMessage(A, "never mind, do this instead", [], {
    allowInert: true,
  });
  expect(cancelled).toEqual([A]);
});
```

- [ ] **Step 7: Run the tests, then typecheck**

Run: `pnpm --filter @dispatch/server test -- test/harness-routes.test.ts test/chat-service.test.ts && pnpm --filter @dispatch/server check`
Expected: PASS; no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/harness-types.ts apps/server/src/routes/agents/shared.ts \
  apps/server/src/routes/agents/harness-routes.ts apps/server/src/server.ts \
  apps/server/src/chat/service.ts apps/server/test/harness-routes.test.ts \
  apps/server/test/chat-service.test.ts
git commit -m "feat(harness): schedule and cancel a limit resume over the API"
```

---

### Task 6: The card

**Files:**

- Create: `apps/web/src/components/app/harness/use-limit-resume.ts`
- Create: `apps/web/src/components/app/chat/turn/limit-card.tsx`
- Modify: `apps/web/src/components/app/harness/use-harness-queue.ts` (`useQueuedPrompts` returns `limitResume`)
- Modify: `apps/web/src/components/app/chat/turn/turn-entry-view.tsx`
- Modify: `apps/web/src/components/app/chat/chat-feed.tsx` (the `case "turn":` branch)
- Test: `apps/web/src/components/app/chat/turn/limit-card.test.tsx`

**Interfaces:**

- Consumes: `ChatTurnEntry.limit` (Task 3), `HarnessQueueResponse.limitResume` and the two routes (Task 5).
- Produces: `<LimitCard limit agentId turnId isNewest />`. `useLimitResume(agentId): { schedule, cancel, pending }`.

A turn entry's id is `turn:<row id>`, the `agent_stream_events` row of the turn (`toTurnEntry` in `apps/server/src/chat/turns.ts`). That number is the `turnId` the routes take. Rows from before turn rows existed have the id `turn:pre:<id>`; they never carry a limit, and the card guards against one anyway. The card is interactive only on the agent's newest turn: a limit three turns back is history, and offering to resume it would be wrong.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/app/chat/turn/limit-card.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const RESUME = vi.hoisted(() => ({
  schedule: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  scheduledAt: null as string | null,
}));
vi.mock("@/components/app/harness/use-limit-resume", () => ({
  useLimitResume: () => ({
    schedule: RESUME.schedule,
    cancel: RESUME.cancel,
    pending: false,
    scheduledAt: RESUME.scheduledAt,
  }),
}));

import { LimitCard } from "./limit-card";

const NOW = new Date("2026-09-20T23:13:00.000Z");
const IN_77_MIN = "2026-09-21T00:30:00.000Z";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  RESUME.schedule.mockClear();
  RESUME.cancel.mockClear();
  RESUME.scheduledAt = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const card = (props: Partial<Parameters<typeof LimitCard>[0]> = {}) =>
  render(
    <LimitCard
      agentId="agt_1"
      turnId={7}
      isNewest={true}
      limit={{ engine: "claude", kind: "session", resetsAt: IN_77_MIN }}
      {...props}
    />
  );

describe("LimitCard", () => {
  it("names the provider, the limit, and how long until it resets", () => {
    card();
    const el = screen.getByTestId("limit-card");
    expect(el.textContent).toContain("Claude Code hit its session limit");
    expect(el.textContent).toContain("in 1 h 17 min");
    expect(el.textContent).toContain("Your work is saved");
    // Never the provider's raw wording or its JSON.
    expect(el.textContent).not.toContain("errorKind");
  });

  it("schedules the resume for the reset time", () => {
    card();
    fireEvent.click(screen.getByTestId("limit-card-continue"));
    expect(RESUME.schedule).toHaveBeenCalledWith({
      turnId: 7,
      resumeAt: IN_77_MIN,
    });
  });

  it("shows a waiting state with Cancel once a resume is scheduled", () => {
    RESUME.scheduledAt = IN_77_MIN;
    card();
    expect(screen.getByTestId("limit-card").textContent).toContain(
      "Will continue by itself"
    );
    expect(screen.queryByTestId("limit-card-continue")).toBeNull();
    fireEvent.click(screen.getByTestId("limit-card-cancel"));
    expect(RESUME.cancel).toHaveBeenCalledTimes(1);
  });

  it("says so plainly when no reset time is known, and offers no schedule", () => {
    card({ limit: { engine: "codex", kind: "usage" } });
    const el = screen.getByTestId("limit-card");
    expect(el.textContent).toContain("Codex hit its usage limit");
    expect(el.textContent).toContain("did not say when it resets");
    expect(screen.queryByTestId("limit-card-continue")).toBeNull();
  });

  it("offers a plain Continue once the reset time has passed", () => {
    card({
      limit: {
        engine: "claude",
        kind: "session",
        resetsAt: "2026-09-20T22:00:00.000Z",
      },
    });
    expect(screen.getByTestId("limit-card").textContent).toContain(
      "The limit has reset"
    );
    expect(screen.getByTestId("limit-card-continue-now")).not.toBeNull();
  });

  it("is a plain record, with no actions, on a turn that is not the newest", () => {
    card({ isNewest: false });
    expect(screen.getByTestId("limit-card").textContent).toContain(
      "Claude Code hit its session limit"
    );
    expect(screen.queryByTestId("limit-card-continue")).toBeNull();
    expect(screen.queryByTestId("limit-card-stop")).toBeNull();
  });

  it("can be dismissed", () => {
    card();
    fireEvent.click(screen.getByTestId("limit-card-stop"));
    expect(screen.queryByTestId("limit-card-continue")).toBeNull();
    expect(screen.getByTestId("limit-card").textContent).toContain(
      "Claude Code hit its session limit"
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat/turn/limit-card.test.tsx`
Expected: FAIL, cannot resolve `./limit-card`.

- [ ] **Step 3: Expose the schedule from the queue query**

In `apps/web/src/components/app/harness/use-harness-queue.ts`, add `HarnessLimitResume` to the shared type imports. Widen `useQueuedPrompts`'s return type with `limitResume: HarnessLimitResume | null;` and return it from the hook:

```ts
    limitResume: query.data?.limitResume ?? null,
```

- [ ] **Step 4: Write the hook**

Create `apps/web/src/components/app/harness/use-limit-resume.ts`:

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

import { harnessQueueQueryKey, useQueuedPrompts } from "./use-harness-queue";

/**
 * A resume Dispatch sends by itself once a provider limit resets. The
 * schedule lives on the queue response, which already refetches on every
 * `harness.changed`, so a resume that fires or is cancelled elsewhere
 * updates the card with no query of its own.
 */
export function useLimitResume(agentId: string | null): {
  schedule: (input: { turnId: number; resumeAt: string }) => Promise<void>;
  cancel: () => Promise<void>;
  pending: boolean;
  scheduledAt: string | null;
} {
  const queryClient = useQueryClient();
  const { limitResume } = useQueuedPrompts(agentId);
  const refresh = () =>
    void queryClient.invalidateQueries({
      queryKey: harnessQueueQueryKey(agentId),
      exact: true,
    });
  const schedule = useMutation<
    void,
    Error,
    { turnId: number; resumeAt: string }
  >({
    mutationFn: (input) =>
      api<void>(`/api/v1/agents/${agentId}/harness/limit-resume`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSettled: refresh,
  });
  const cancel = useMutation<void, Error>({
    mutationFn: () =>
      api<void>(`/api/v1/agents/${agentId}/harness/limit-resume`, {
        method: "DELETE",
      }),
    onSettled: refresh,
  });
  return {
    schedule: schedule.mutateAsync,
    cancel: cancel.mutateAsync,
    pending: schedule.isPending || cancel.isPending,
    scheduledAt: limitResume?.resumeAt ?? null,
  };
}
```

- [ ] **Step 5: Write the card**

Create `apps/web/src/components/app/chat/turn/limit-card.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Hourglass } from "lucide-react";
import { HARNESS_ENGINES, type HarnessLimit } from "@dispatch/shared";

import { useLimitResume } from "@/components/app/harness/use-limit-resume";
import { Button } from "@/components/ui/button";

const KIND_LABEL: Record<HarnessLimit["kind"], string> = {
  session: "session limit",
  weekly: "weekly limit",
  usage: "usage limit",
  unknown: "usage limit",
};

function engineLabel(engine: HarnessLimit["engine"]): string {
  return HARNESS_ENGINES.find((e) => e.id === engine)?.label ?? engine;
}

/** "1 h 17 min", "17 min", "less than a minute". */
export function untilLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Re-render on a clock tick so the countdown and the "has reset" flip move. */
function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/**
 * A turn that ended because the provider ran out of allowance. Built from
 * `entry.limit` alone: nothing here reads the provider's error wording.
 *
 * Interactive only on the agent's newest turn. A limit further back is
 * history, and resuming it would restart work the user has moved past.
 */
export function LimitCard({
  limit,
  agentId,
  turnId,
  isNewest,
}: {
  limit: HarnessLimit;
  agentId: string;
  turnId: number;
  isNewest: boolean;
}): JSX.Element {
  const { schedule, cancel, pending, scheduledAt } = useLimitResume(agentId);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN;
  const hasTime = Number.isFinite(resetsAt);
  const now = useNow(30_000, isNewest && hasTime);
  const remaining = hasTime ? resetsAt - now : 0;
  const hasReset = hasTime && remaining <= 0;
  // A pre-turn group's id is not a number: nothing to schedule against.
  const interactive = isNewest && !dismissed && Number.isInteger(turnId);

  const run = (action: () => Promise<void>, fallback: string) => {
    setError(null);
    action().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : fallback)
    );
  };

  let detail: string;
  if (!hasTime) {
    detail = `${engineLabel(limit.engine)} did not say when it resets.`;
  } else if (hasReset) {
    detail = "The limit has reset.";
  } else {
    const at = new Date(resetsAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    detail = `Resets at ${at}, in ${untilLabel(remaining)}.`;
  }

  return (
    <div
      className="my-1 rounded-md border border-status-waiting/40 bg-status-waiting/10 px-3 py-2 text-[12px]"
      data-testid="limit-card"
      data-engine={limit.engine}
    >
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <Hourglass
          className="h-3.5 w-3.5 shrink-0 text-status-waiting"
          aria-hidden="true"
        />
        {engineLabel(limit.engine)} hit its {KIND_LABEL[limit.kind]}
      </div>
      <p className="mt-0.5 text-muted-foreground">
        {detail} Your work is saved and nothing was lost.
      </p>
      {interactive && scheduledAt ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span data-testid="limit-card-waiting">
            Will continue by itself
            {hasTime && !hasReset ? ` in ${untilLabel(remaining)}` : " shortly"}
            .
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => run(cancel, "Could not cancel.")}
            data-testid="limit-card-cancel"
          >
            Cancel
          </Button>
        </div>
      ) : interactive ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {hasTime && !hasReset ? (
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    schedule({
                      turnId,
                      resumeAt: new Date(resetsAt).toISOString(),
                    }),
                  "Could not schedule."
                )
              }
              data-testid="limit-card-continue"
            >
              Continue when it resets
            </Button>
          ) : null}
          {hasReset ? (
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    schedule({
                      turnId,
                      // The route wants a future time; a moment from now
                      // is "now" for a limit that has already reset.
                      resumeAt: new Date(Date.now() + 2_000).toISOString(),
                    }),
                  "Could not continue."
                )
              }
              data-testid="limit-card-continue-now"
            >
              Continue
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setDismissed(true)}
            data-testid="limit-card-stop"
          >
            Stop here
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="mt-1 text-status-blocked" data-testid="limit-card-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6: Run the card tests to verify they pass**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/chat/turn/limit-card.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 7: Render it on the turn**

In `apps/web/src/components/app/chat/turn/turn-entry-view.tsx`, import the card:

```tsx
import { LimitCard } from "./limit-card";
```

Add to `TurnEntryViewProps`:

```tsx
  /** This is the agent's newest turn: its limit card may still be acted on. */
  isNewest?: boolean;
```

Destructure `isNewest = false` in `TurnEntryViewImpl`. Inside `<AutoHeight data-testid="chat-turn-body">`, after `<ResultTurn turn={result} />`:

```tsx
{
  entry.limit ? (
    <LimitCard
      limit={entry.limit}
      agentId={entry.agentId}
      turnId={Number(entry.id.slice("turn:".length))}
      isNewest={isNewest}
    />
  ) : null;
}
```

The feed renders turns in `apps/web/src/components/app/chat/chat-feed.tsx`, in the `case "turn":` branch of its row renderer. Above the renderer, beside the component's other memos, compute the newest turn once:

```tsx
const newestTurnId = useMemo(
  () => entries.findLast((entry) => entry.type === "turn")?.id ?? null,
  [entries]
);
```

Use whatever name that component gives its list of feed entries if it is not `entries`. Then pass it down:

```tsx
        case "turn":
          return (
            <TurnEntryView
              entry={entry}
              grouped={row.grouped}
              rule={row.rule}
              ctx={ctx}
              isNewest={entry.id === newestTurnId}
            />
          );
```

Add to `apps/web/src/components/app/chat/turn/turn-entry-view.test.tsx`, using that file's existing entry factory and render helper:

```tsx
it("shows the limit card in place of the error text", () => {
  renderEntry({
    settled: true,
    result: null,
    limit: { engine: "claude", kind: "session" },
    trace: {
      startedAt: "2026-09-02T10:00:00.000Z",
      finalResult: "error",
      steps: [],
    },
  });
  expect(screen.getByTestId("limit-card")).not.toBeNull();
  expect(screen.getByTestId("chat-turn").textContent).not.toContain(
    "Internal error"
  );
});
```

If that test file mocks no query client, mock the hook the same way `limit-card.test.tsx` does, at the top of the file.

- [ ] **Step 8: Run the web suite and typecheck**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/app/harness/use-limit-resume.ts \
  apps/web/src/components/app/harness/use-harness-queue.ts \
  apps/web/src/components/app/chat/turn/limit-card.tsx \
  apps/web/src/components/app/chat/turn/limit-card.test.tsx \
  apps/web/src/components/app/chat/turn/turn-entry-view.tsx \
  apps/web/src/components/app/chat/turn/turn-entry-view.test.tsx \
  apps/web/src/components/app/chat/chat-feed.tsx
git commit -m "feat(chat): show a provider limit as one card with a scheduled resume"
```

---

### Task 7: End to end, the setting, and docs

**Files:**

- Modify: `e2e/fixtures/fake-acp-agent.mjs`
- Modify: `e2e/harness-agent.spec.ts`
- Modify: `apps/server/src/routes/system.ts` (settings routes)
- Modify: `docs/10-operations-runbook.md`
- Modify: `release-notes/current.md`

**Interfaces:**

- Consumes: everything above.
- Produces: a `limit:<minutes>` directive in the fake engine. `GET` and `POST /api/v1/app/settings/harness-limit-card`, matching the neighboring settings routes.

- [ ] **Step 1: Teach the fake engine to hit a limit**

In `e2e/fixtures/fake-acp-agent.mjs`, beside `const HANG = /hang:(\d+)/;`:

```js
// "limit:<minutes>": fail the turn the way Claude Code does when the plan
// runs out, with the reset that many minutes away. "limit:0" gives the form
// with no time in it at all.
const LIMIT = /limit:(\d+)/;
```

At the top of `prompt(params)`, after `emit` is defined:

```js
const limit = LIMIT.exec(text);
if (limit) {
  const minutes = Number(limit[1]);
  const message =
    minutes === 0
      ? "turn failed: Codex error: The usage limit has been reached"
      : `You have hit your ChatGPT usage limit (plus plan). Try again in ~${minutes} min.`;
  throw new acp.RequestError(-32603, `Internal error: ${message}`);
}
```

The relative form is used because it is the one wording whose reset time does not depend on the test host's clock zone.

- [ ] **Step 2: Write the end-to-end test**

In `e2e/harness-agent.spec.ts`, after the "a stopped turn shows no step still running" test:

```ts
test("a provider limit shows one card and resumes by itself", async ({
  page,
  request,
}) => {
  await setEnabledAgentTypesViaAPI(request, ["claude", "codex"]);
  await setDispatchHarnessViaAPI(request, true);
  await setChatSurface(request, true);
  const repo = makeRepo();
  const agent = await createAgentViaAPI(request, {
    name: `e2e-harness-limit-${Date.now()}`,
    type: "dispatch",
    cwd: repo,
    useWorktree: true,
  });
  expect(agent.status).toBe("running");

  await loadApp(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await clickAgentRow(page, agent.id);
  await page.getByTestId("center-tab-agent").click();
  const pane = page.getByTestId("chat-pane");
  const input = pane.getByTestId("chat-composer-input");
  await expect(input).toBeEnabled({ timeout: 30_000 });

  await input.fill("limit:90 refactor the parser");
  await input.press("Enter");

  // One card, in words, with no trace of the provider's raw error.
  const card = pane.getByTestId("limit-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("hit its usage limit");
  await expect(card).toContainText("in 1 h");
  await expect(pane.getByTestId("limit-card")).toHaveCount(1);
  await expect(pane.getByTestId("chat-scroll")).not.toContainText(
    "Internal error"
  );
  await page.screenshot({
    path: test.info().outputPath("harness-limit-card.png"),
    fullPage: true,
  });

  // Schedule it, and the card waits with a Cancel.
  await card.getByTestId("limit-card-continue").click();
  await expect(card.getByTestId("limit-card-waiting")).toBeVisible();
  const queue = await request.get(`/api/v1/agents/${agent.id}/harness/queue`);
  expect((await queue.json()).limitResume).not.toBeNull();

  // The user typing takes over: the scheduled resume goes.
  await input.fill("say:never mind");
  await input.press("Enter");
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get(`/api/v1/agents/${agent.id}/harness/queue`)
          ).json()
        ).limitResume,
      { timeout: 30_000 }
    )
    .toBeNull();
});
```

- [ ] **Step 3: Run it live**

Run: `E2E_AGENT_RUNTIME=tmux bash scripts/e2e-isolated.sh --no-deps e2e/harness-agent.spec.ts -g "provider limit"`
Expected: 1 passed.

The harness spec is skipped without `E2E_AGENT_RUNTIME=tmux`. A run that reports it skipped has not tested it.

- [ ] **Step 4: Expose the setting**

In `apps/server/src/routes/system.ts`, directly after the `subtask-model-downshift` pair, add a matching pair. Import `isHarnessLimitCardEnabled` and `setHarnessLimitCardEnabled` from `../harness-limit-settings.js`.

```ts
app.get("/api/v1/app/settings/harness-limit-card", async () => {
  return { enabled: await isHarnessLimitCardEnabled(deps.pool) };
});

app.post("/api/v1/app/settings/harness-limit-card", async (request, reply) => {
  const body = request.body as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return reply.code(400).send({ error: "enabled must be a boolean." });
  }
  await setHarnessLimitCardEnabled(deps.pool, body.enabled);
  return { enabled: body.enabled };
});
```

Find the test that covers `subtask-model-downshift` (`grep -rn "subtask-model-downshift" apps/server/test`) and add a sibling beside it with the same three assertions: `GET` reads `true` by default, `POST { enabled: false }` then `GET` reads `false`, and a non-boolean body is `400`.

- [ ] **Step 5: Document it**

In `docs/10-operations-runbook.md`, after the paragraph that ends "held to one provider request every five seconds.", add:

```markdown
When a turn fails because the provider ran out of allowance, Dispatch records it
as a limit and not as an ordinary failure. It trusts the provider's own code
first (`errorKind: rate_limit` from Claude Code, `codexErrorInfo:
usageLimitExceeded` from Codex) and known phrases second. The feed then shows
one card with the provider, the limit, and the reset time. The reset time comes
from the plan report when that has an exhausted window resetting in the future,
and from the error text otherwise. When neither has one, the card says so and
offers nothing to schedule.

"Continue when it resets" stores a row in `agent_scheduled_resumes`, so a server
restart before the reset loses nothing: pending rows are reloaded at boot, and
one already past due fires at once. A resume gets one attempt. If the resumed
turn meets the limit again, the card comes back with the new time and nothing is
rescheduled unless asked. Any message from the user cancels a pending resume.

`harness_limit_card_enabled` (default on) turns the whole feature off: a limit is
an ordinary failed turn again, with the provider's raw text.
```

In `release-notes/current.md`, after the "Edit a running message" bullet:

```markdown
- **Provider limits**: a turn that ends because the provider ran out of allowance shows one card naming the provider, the limit, and when it resets, in place of the raw error. "Continue when it resets" resumes the work by itself at that time, survives a server restart, and is cancelled by any message you send. Works for every provider. Turn it off with `harness_limit_card_enabled`.
```

- [ ] **Step 6: Run everything**

Run:

```bash
pnpm run check
pnpm --filter @dispatch/server test
cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run && cd ../..
pnpm run finalize:web
npx prettier --check $(git diff --name-only HEAD~6)
```

Expected: all pass. Four `harness-usage-engine-*` assertions in `e2e/harness-agent.spec.ts` fail on a host with a real subscription login and failed before this work; they are not a regression.

- [ ] **Step 7: Commit**

```bash
git add e2e/fixtures/fake-acp-agent.mjs e2e/harness-agent.spec.ts \
  apps/server/src/routes/system.ts docs/10-operations-runbook.md \
  release-notes/current.md
git add -u apps/server/test
git commit -m "test(e2e): cover the limit card and its scheduled resume"
```
