# Dispatch Harness engines, plan 2 of 3: web

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point the Harness view at the engine-agnostic server from plan 1: tasks from `turn.plan`, the slash menu from `/harness/commands`, nested subagent steps from `step.children`, usage by engine, honest empty states where an engine publishes nothing, the harness icon, and one motion system for every transition.

**Architecture:** The view keeps its shape (`turn-stream`, `activity-block`, `step-row`, `harness-pane`); five feeds change source and the dsh-only pieces (goal strip, subagent log fetch, todo sniffing, provider billing) are deleted. Motion is centralized in `harness/motion.ts` and applied with `framer-motion`, which the app already depends on. The spec is `docs/superpowers/specs/2026-09-07-dispatch-harness-acp-engines-design.md`; plan 1 (`2026-09-07-harness-engines-1-server.md`) must be complete first.

**Tech Stack:** React 18, TypeScript, Tailwind, shadcn/ui, `framer-motion@^12`, TanStack Query, Vitest + Testing Library (jsdom), `sharp` for the icon generator.

## Global Constraints

- Every transition in `apps/web/src/components/app/harness/` uses a token from `harness/motion.ts`; no ad-hoc `duration-*` or `ease-*` class and no new `@keyframes`. `animate-harness-row`, `animate-harness-msg`, `animate-harness-pop` are removed from `tailwind.config.ts` once nothing references them.
- Reduced motion: framer through `useReducedMotion` via a `MotionConfig reducedMotion="user"` at the pane root; CSS through `motion-reduce:`. Tests render under `MotionConfig reducedMotion="always"`.
- Where an engine publishes nothing for a control (no `model` option, no usage), the control says so and is disabled; it does not render empty or fetch forever. The tasks strip simply stays unmounted while no plan exists, the same as before an engine's first plan.
- Copy: American spelling; no em-dashes in prose, comments, or UI copy; engine names are `HARNESS_ENGINES[i].label`; nothing says "dsh", "DeepSeek", or "provider key".
- Prefer shadcn primitives (`Dialog`, `Select`, `Button`, `Tooltip`) over hand-rolled ones.
- Web tests: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run <file>`. Type check: `pnpm run check:web`. Final gate: `pnpm run finalize:web` (check + production build) and `pnpm run check` at the root.
- Commit messages: `type(web): imperative subject`, lowercase after the colon, body wrapped at 72, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Worktree `/home/nii/.dispatch/server-dsh-harness`, branch `dsh-harness-deploy`.

---

## File structure

| Path                                                                                                                        | Responsibility after this plan                                                                          |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `harness/contracts.ts`                                                                                                      | `Step.children`, `Turn.extra.plan` / `usage` documented.                                                |
| `harness/use-harness-turns.ts`                                                                                              | Maps `HarnessTurn.plan`, `usage`, `HarnessStep.children`; returns `livePlan`.                           |
| `harness/registry.ts`                                                                                                       | `latestPlanItems(turns, livePlan, streaming)`; `hasChildren(step)`; todo/subagent/goal helpers deleted. |
| `harness/use-harness-commands.ts`                                                                                           | **New** (replaces `use-harness-skills.ts`): `/harness/commands` as `SlashItem[]`.                       |
| `harness/step-detail.tsx`                                                                                                   | Renders `step.children` as a nested rail. `subagent-detail.tsx`, `use-harness-subagent.ts` deleted.     |
| `harness/provider-icon.tsx`                                                                                                 | Engine marks: Claude, Codex, Gemini, OpenCode; `providerOf(engineOrModelId)`.                           |
| `harness/model-picker.tsx`                                                                                                  | `fixedReason` prop for engines that set their model at launch.                                          |
| `harness/usage-dialog.tsx`, `use-harness-usage.ts`                                                                          | Engine rows from `HarnessUsageResponse.engines`.                                                        |
| `components/app/usage-budget-settings.tsx`                                                                                  | Rows from `HARNESS_BUDGET_ENGINE_IDS`.                                                                  |
| `harness/motion.ts`                                                                                                         | **New.** Tokens and shared variants.                                                                    |
| `harness/turn-stream.tsx`, `activity-block.tsx`, `step-row.tsx`, `queued-prompt.tsx`, `tasks-strip.tsx`, `harness-pane.tsx` | Motion applied; goal strip removed; starting-screen login hint.                                         |
| `components/app/agent-type-icon.tsx`, `public/harness-icon.svg`, `scripts/generate-icon-colors.ts`                          | The harness icon and its per-color variants.                                                            |
| `components/app/agent-type-settings.tsx`                                                                                    | The `dispatch` description.                                                                             |
| `packages/shared/src/harness-types.ts`                                                                                      | The `@deprecated` dsh-era types from plan 1 are deleted here.                                           |

---

### Task 1: Turns carry plan, usage and children into the view

**Files:**

- Modify: `apps/web/src/components/app/harness/contracts.ts:13-24`
- Modify: `apps/web/src/components/app/harness/use-harness-turns.ts`
- Test: `apps/web/src/components/app/harness/use-harness-turns.test.tsx`

**Interfaces:**

- Consumes: `HarnessTurn.plan?: HarnessPlanEntry[]`, `HarnessTurn.usage?`, `HarnessStep.children?` (plan 1, Task 3).
- Produces: `Step.children?: Step[]`; `Turn.extra.plan?: HarnessPlanEntry[]`; `Turn.extra.usage?: { used; size; costUsd }`; `useHarnessTurns(...)` returns `livePlan: HarnessPlanEntry[] | null` and `toPromptKitTurns` returns `livePlan` too.

- [ ] **Step 1: Write the failing test**

Append to `use-harness-turns.test.tsx`:

```ts
describe("toPromptKitTurns: plan, usage, children", () => {
  const nested: HarnessTurn = {
    id: "turn:3",
    prompt: { source: "chat", text: "delegate", attachments: [] },
    trace: {
      startedAt: "2026-09-07T10:00:00.000Z",
      endedAt: "2026-09-07T10:00:09.000Z",
      finalResult: "ok",
      steps: [
        {
          id: "stream:1",
          kind: "other",
          label: "Task",
          status: "ok",
          startedAt: "2026-09-07T10:00:01.000Z",
          endedAt: "2026-09-07T10:00:08.000Z",
          durMs: 7000,
          detail: {},
          children: [
            {
              id: "stream:2",
              kind: "read",
              label: "Read",
              status: "ok",
              startedAt: "2026-09-07T10:00:02.000Z",
              endedAt: "2026-09-07T10:00:03.000Z",
              durMs: 1000,
              detail: {
                locations: [{ path: "a.ts" }],
                parentToolCallId: "task_1",
              },
            },
          ],
        },
      ],
    },
    result: { text: "Done.", streaming: false },
    plan: [{ content: "a", status: "completed", priority: "high" }],
    usage: { used: 4200, size: 200000, costUsd: 0.5 },
  };

  it("keeps children on steps and plan and usage on the assistant turn", () => {
    const { turns, livePlan } = toPromptKitTurns([nested], "agt_1");
    const assistant = turns[1];
    expect(assistant.trace?.steps[0].children?.map((s) => s.label)).toEqual([
      "Read",
    ]);
    expect(assistant.extra?.plan).toEqual([
      { content: "a", status: "completed", priority: "high" },
    ]);
    expect(assistant.extra?.usage).toEqual({
      used: 4200,
      size: 200000,
      costUsd: 0.5,
    });
    expect(livePlan).toBeNull();
  });

  it("exposes the live turn's plan while it is open", () => {
    const open: HarnessTurn = {
      ...nested,
      id: "turn:4",
      trace: { ...nested.trace, endedAt: undefined, finalResult: undefined },
      result: null,
    };
    const { livePlan, streaming } = toPromptKitTurns([open], "agt_1");
    expect(streaming).toBe(true);
    expect(livePlan).toEqual([
      { content: "a", status: "completed", priority: "high" },
    ]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/use-harness-turns.test.tsx`
Expected: FAIL: `children` is dropped by `toStep`, `extra.plan` is undefined, `livePlan` is not returned.

- [ ] **Step 3: Carry the fields through**

`contracts.ts`, in `Step`:

```ts
export interface Step {
  id: string;
  kind: string;
  label?: string;
  attempt?: number;
  status: StepStatus;
  startedAt: number;
  endedAt?: number;
  durMs?: number;
  reason?: string;
  detail?: unknown;
  /** Steps run under this one: a subagent's work, nested one level in the rail. */
  children?: Step[];
}
```

`use-harness-turns.ts`:

```ts
import type {
  ChatAttachment,
  HarnessPlanEntry,
  HarnessQueuedPrompt,
  HarnessQuestion,
  HarnessStep,
  HarnessTurn,
  HarnessTurnsResponse,
} from "@dispatch/shared";
```

```ts
function toStep(step: HarnessStep): Step {
  return {
    id: step.id,
    kind: step.kind,
    label: step.label,
    status: step.status,
    startedAt: Date.parse(step.startedAt),
    ...(step.endedAt ? { endedAt: Date.parse(step.endedAt) } : {}),
    ...(step.durMs !== undefined ? { durMs: step.durMs } : {}),
    detail: step.detail,
    ...(step.children?.length ? { children: step.children.map(toStep) } : {}),
  };
}
```

In `toPromptKitTurns`, add `let livePlan: HarnessPlanEntry[] | null = null;` beside `liveText`, set `livePlan = turn.plan ?? null;` inside the `isLast && open` branch before `return`, put `plan` and `usage` on the assistant turn's `extra`, and return `livePlan`:

```ts
      extra: {
        ...(turn.questions?.length ? { questions: turn.questions } : {}),
        ...(turn.plan ? { plan: turn.plan } : {}),
        ...(turn.usage ? { usage: turn.usage } : {}),
        label: turn.label ?? turnLabelFromSteps(trace.steps),
      },
```

```ts
return { turns: out, liveTrace, liveText, liveQuestions, livePlan, streaming };
```

Update the function's return type and `useHarnessTurns`'s return type to include `livePlan: HarnessPlanEntry[] | null`.

- [ ] **Step 4: Run the test to see it pass**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/use-harness-turns.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/app/harness/contracts.ts apps/web/src/components/app/harness/use-harness-turns.ts apps/web/src/components/app/harness/use-harness-turns.test.tsx
git commit -m "feat(web): carry plan, usage and nested steps into the harness turn model

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The tasks strip reads the plan

**Files:**

- Modify: `apps/web/src/components/app/harness/registry.ts`
- Modify: `apps/web/src/components/app/harness/harness-pane.tsx:26,150-155,413-419`
- Test: `apps/web/src/components/app/harness/registry.test.ts`

**Interfaces:**

- Produces: `latestPlanItems(turns: Turn[], livePlan: HarnessPlanEntry[] | null, streaming: boolean): TodoItem[]` (replaces `latestTodoItems`); `TodoItem` unchanged (`{ content; status }`). Removed: `isTodoStep`, `todoItems`, `isSubagentStep`, `subagentSessionId`, `GoalState`, `goalFromStep`, `latestGoal`, `unwrapReadOutput`'s dsh comment.

- [ ] **Step 1: Write the failing test**

In `registry.test.ts`, delete every test that references `isTodoStep`, `todoItems`, `latestTodoItems`, `isSubagentStep`, `subagentSessionId`, `goalFromStep`, or `latestGoal`, and add:

```ts
import { latestPlanItems, stepLabel, stepSummary } from "./registry";
import type { Step, Turn } from "./contracts";

const at = Date.parse("2026-09-07T10:00:00Z");
const assistantTurn = (plan?: unknown): Turn => ({
  id: "t:assistant",
  role: "assistant",
  content: "",
  timestamp: at,
  trace: { startedAt: at, endedAt: at + 1000, steps: [] },
  extra: plan ? { plan } : {},
});

describe("latestPlanItems", () => {
  const plan = [
    { content: "a", status: "completed", priority: "high" },
    { content: "b", status: "in_progress", priority: "low" },
  ];
  it("prefers the live plan while streaming", () => {
    expect(latestPlanItems([assistantTurn(plan)], [plan[1]], true)).toEqual([
      { content: "b", status: "in_progress" },
    ]);
  });
  it("falls back to the newest assistant turn's plan", () => {
    expect(
      latestPlanItems(
        [
          assistantTurn([plan[0]]),
          { id: "u", role: "user", content: "x", timestamp: at },
          assistantTurn(plan),
        ],
        null,
        false
      )
    ).toEqual([
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
    ]);
  });
  it("is empty when no turn carries a plan", () => {
    expect(latestPlanItems([assistantTurn()], null, false)).toEqual([]);
  });
});

describe("stepLabel", () => {
  it("no longer special-cases a todo tool", () => {
    const step: Step = {
      id: "s",
      kind: "other",
      label: "todo_write",
      status: "ok",
      startedAt: at,
    };
    expect(stepLabel(step)).toBe("todo_write");
    expect(stepSummary(step)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/registry.test.ts`
Expected: FAIL: `latestPlanItems` is not exported.

- [ ] **Step 3: Rewrite the registry**

In `registry.ts`:

- Change the import to `import type { Step, Trace, Turn } from "./contracts";` and add `import type { HarnessPlanEntry } from "@dispatch/shared";`.
- In `StepDetailData`, replace `subagentSessionId?: string;` with `parentToolCallId?: string;` and reword the `input` comment to "The tool call's raw input, as the engine sent it."
- Delete `isSubagentStep`, `isTodoStep`, `todoItems`, `latestTodoItems`, `subagentSessionId`, and everything from `/** dsh's goal loop ... */` (`GoalState`, `GOAL_TOOLS`, `goalFromStep`, `latestGoal`) to the end of the file.
- Add:

```ts
export type TodoItem = {
  content: string;
  /** pending | in_progress | completed */
  status: string;
};

/**
 * The task list as the engine last published it: the live turn's plan while
 * one runs, else the newest assistant turn's; empty when neither has one.
 */
export function latestPlanItems(
  turns: Turn[],
  livePlan: HarnessPlanEntry[] | null,
  streaming: boolean
): TodoItem[] {
  const toItems = (plan: HarnessPlanEntry[]) =>
    plan.map((e) => ({ content: e.content, status: e.status }));
  if (streaming && livePlan) return toItems(livePlan);
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const plan = turns[i].extra?.plan;
    if (turns[i].role === "assistant" && Array.isArray(plan)) {
      return toItems(plan as HarnessPlanEntry[]);
    }
  }
  return [];
}

/** Whether steps ran under this one (a subagent's work). */
export function hasChildren(step: Step): boolean {
  return (step.children?.length ?? 0) > 0;
}
```

- In `stepLabel` delete the `if (isTodoStep(step)) return "tasks";` line. In `stepSummary` delete the `isSubagentStep` and `isTodoStep` branches. In `hasSettledDetail` replace the first two lines with `if (hasChildren(step)) return true;`. In `unwrapReadOutput`'s comment write "A read tool may wrap its output as ...".

In `harness-pane.tsx`: import `latestPlanItems` instead of `latestGoal, latestTodoItems`; destructure `livePlan` from `useHarnessTurns`; replace the `currentTasks` memo:

```ts
const currentTasks = useMemo(
  () => latestPlanItems(turns, livePlan, streaming),
  [livePlan, streaming, turns]
);
const tasksOpen = currentTasks.some((t) => t.status !== "completed");
```

Delete the `goal` memo, the `GoalStrip` import, and the `{goal ? <GoalStrip goal={goal} /> : null}` line. Delete `apps/web/src/components/app/harness/goal-strip.tsx`.

In `harness-pane.test.tsx`, the `describe("HarnessPane tasks and subagents")` block (from line 577) built its list from a `todo_write` step. Rewrite it: drop the `todoStep` helper, give the assistant turn `extra: { plan: [ { content: "Read the README", status: "completed", priority: "high" }, { content: "Echo the prompt", status: "in_progress", priority: "medium" }, { content: "Wrap up", status: "pending", priority: "low" } ] }` (and `trace.steps: []`), keep every assertion on `harness-tasks`, `harness-todo-item`, `harness-tasks-more`, and `harness-tasks-toggle`, and delete the assertions that a step reads as "tasks" or expands into the list (there is no such step now). The all-completed case keeps its assertion that the strip is absent.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/registry.test.ts src/components/app/harness/harness-pane.test.tsx`
Expected: PASS for the registry. The pane test may fail on the `use-harness-skills` mock (renamed in Task 4); if so, that failure is the expected pre-state for Task 4 and this task's commit still lands.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src/components/app/harness
git commit -m "feat(web): feed the tasks strip from the engine's plan

The strip reads turn.plan (live or newest settled) instead of sniffing a
todo tool's arguments; the goal strip and the dsh goal parsing go.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Nested steps replace the subagent log fetch

**Files:**

- Modify: `apps/web/src/components/app/harness/step-detail.tsx`
- Modify: `apps/web/src/components/app/harness/activity-block.tsx:11,66-78,99-108`
- Modify: `apps/web/src/components/app/harness/step-row.tsx` (accept `depth`)
- Delete: `apps/web/src/components/app/harness/subagent-detail.tsx`, `use-harness-subagent.ts`
- Test: `apps/web/src/components/app/harness/step-row.test.tsx`

**Interfaces:**

- Produces: `StepRow` gains `depth?: number` (default 0) and renders `step.children` as a nested `role="list"` under its detail area when open; `activity-block` keeps a step with children open while the turn runs (was `isSubagentStep`).

- [ ] **Step 1: Write the failing test**

Append to `step-row.test.tsx` (it already renders `StepRow` with a `step` fixture and Testing Library):

```ts
describe("StepRow with children", () => {
  const at = Date.parse("2026-09-07T10:00:00Z");
  const parent: Step = {
    id: "p",
    kind: "other",
    label: "Task",
    status: "ok",
    startedAt: at,
    endedAt: at + 5000,
    durMs: 5000,
    detail: { input: { description: "look around" } },
    children: [
      { id: "c1", kind: "read", label: "Read", status: "ok", startedAt: at + 1000, endedAt: at + 2000, durMs: 1000, detail: { locations: [{ path: "a.ts" }] } },
      { id: "c2", kind: "execute", label: "bash", status: "ok", startedAt: at + 2000, endedAt: at + 3000, durMs: 1000, detail: { input: { command: "ls" }, terminalOutput: "a.ts" } },
    ],
  };

  it("is expandable and lists the children as a nested rail when open", () => {
    render(<StepRow step={parent} open onToggle={() => {}} maskClass="bg-muted" />);
    const nested = screen.getByTestId("harness-nested-steps");
    expect(nested.getAttribute("role")).toBe("list");
    expect(within(nested).getAllByTestId("harness-step")).toHaveLength(2);
    expect(within(nested).getAllByTestId("harness-step")[0]).toHaveAttribute("data-depth", "1");
  });

  it("shows no nested rail when closed", () => {
    render(<StepRow step={parent} open={false} onToggle={() => {}} maskClass="bg-muted" />);
    expect(screen.queryByTestId("harness-nested-steps")).toBeNull();
  });
});
```

(Add `within` to the Testing Library import.)

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/step-row.test.tsx`
Expected: FAIL: no element with test id `harness-nested-steps`.

- [ ] **Step 3: Render children in the detail**

`step-row.tsx`: add a `depth` prop and pass it through; the outer `div` gets `data-depth={depth}`:

```ts
export function StepRow({
  step,
  open,
  onToggle,
  maskClass,
  depth = 0,
}: {
  step: Step;
  open: boolean;
  onToggle: () => void;
  maskClass: string;
  /** 0 at the rail's top level; children render one deeper. */
  depth?: number;
}): JSX.Element {
```

and in the JSX the wrapper becomes `<div className="..." role="listitem" data-depth={depth} ...>` and the detail render becomes `<StepDetail step={step} depth={depth} />` in both branches.

`step-detail.tsx`: import `hasChildren` from `./registry` and `StepRow` from `./step-row` (a cycle between the two modules is fine for React components at call time), remove the `SubagentDetail` import and its branch, and add a `depth` prop; before the existing body switch:

```tsx
export function StepDetail({
  step,
  depth = 0,
}: {
  step: Step;
  depth?: number;
}): JSX.Element | null {
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  if (hasChildren(step)) {
    return (
      <div className="mt-1.5 space-y-2" data-testid="harness-step-children">
        <DetailBody step={step} />
        <div className="relative pl-3">
          <span
            aria-hidden="true"
            className="absolute bottom-1 left-[5.5px] top-1 w-px bg-border/70"
          />
          <div
            role="list"
            aria-label="subagent steps"
            data-testid="harness-nested-steps"
          >
            {step.children!.map((child) => (
              <StepRow
                key={child.id}
                step={child}
                open={openIds[child.id] ?? child.status === "running"}
                onToggle={() =>
                  setOpenIds((prev) => ({
                    ...prev,
                    [child.id]: !(prev[child.id] ?? child.status === "running"),
                  }))
                }
                maskClass="bg-muted"
                depth={depth + 1}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }
  return <DetailBody step={step} />;
}
```

where `DetailBody` is the existing per-kind body renamed (the `switch` on `step.kind` that draws diffs, output, locations, text, and JSON input). Keep its `default` branch so a Task step with an `input.description` shows that text above the nested rail.

`activity-block.tsx`: replace `import { isSubagentStep } from "./registry";` with `import { hasChildren } from "./registry";`, and in `stepOpen`:

```ts
const stepOpen = (step: Step): boolean =>
  stepOverrides[step.id] ??
  (!done && (step.status === "running" || hasChildren(step)));
```

Delete `subagent-detail.tsx` and `use-harness-subagent.ts`; in `harness-pane.test.tsx` delete the `vi.mock("./use-harness-subagent", ...)` block and the `subagentState` object.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/step-row.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src/components/app/harness
git commit -m "feat(web): render a subagent's steps nested under its parent step

Nested steps arrive on the turn; the child-session fetch and the dsh
log-backed SubagentDetail are gone.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The slash menu lists the engine's commands

**Files:**

- Create: `apps/web/src/components/app/harness/use-harness-commands.ts`
- Delete: `apps/web/src/components/app/harness/use-harness-skills.ts`
- Modify: `apps/web/src/components/app/harness/harness-pane.tsx:38,105,176-191`
- Modify: `apps/web/src/components/app/harness/harness-pane.test.tsx:55-61`
- Test: `apps/web/src/components/app/harness/use-harness-commands.test.tsx` (new)

**Interfaces:**

- Consumes: `GET /api/v1/agents/:id/harness/commands` → `HarnessCommandsResponse` (plan 1, Task 9); `SlashItem` from `chat-composer.tsx`.
- Produces: `useHarnessCommands(agentId: string | null): SlashItem[]`; `harnessCommandsQueryKey(agentId)`.

- [ ] **Step 1: Write the failing test**

Create `use-harness-commands.test.tsx`:

```tsx
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useHarnessCommands } from "./use-harness-commands";

const api = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => api(...args) }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => api.mockReset());

describe("useHarnessCommands", () => {
  it("maps the engine's commands to slash items, hint folded into the description", async () => {
    api.mockResolvedValue({
      commands: [
        { name: "review", description: "Review the branch", input: null },
        {
          name: "compact",
          description: "Compact the context",
          input: { hint: "what to keep" },
        },
      ],
    });
    const { result } = renderHook(() => useHarnessCommands("agt_1"), {
      wrapper,
    });
    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(api).toHaveBeenCalledWith("/api/v1/agents/agt_1/harness/commands");
    expect(result.current).toEqual([
      { name: "review", description: "Review the branch" },
      { name: "compact", description: "Compact the context · what to keep" },
    ]);
  });

  it("asks nothing without an agent", () => {
    const { result } = renderHook(() => useHarnessCommands(null), { wrapper });
    expect(result.current).toEqual([]);
    expect(api).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/use-harness-commands.test.tsx`
Expected: FAIL: module not found.

- [ ] **Step 3: Write the hook and wire it**

Create `use-harness-commands.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import type { HarnessCommandsResponse } from "@dispatch/shared";

import type { SlashItem } from "@/components/app/chat/chat-composer";
import { api } from "@/lib/api";

export function harnessCommandsQueryKey(agentId: string | null) {
  return ["harness-commands", agentId] as const;
}

/** The slash commands the engine advertised, shaped for the composer's "/" menu. */
export function useHarnessCommands(agentId: string | null): SlashItem[] {
  const query = useQuery({
    queryKey: harnessCommandsQueryKey(agentId),
    queryFn: () =>
      api<HarnessCommandsResponse>(
        `/api/v1/agents/${agentId}/harness/commands`
      ),
    enabled: agentId !== null,
    // The list changes when the session comes up or a skill is added; the
    // harness.changed SSE signal invalidates it, this covers the rest.
    staleTime: 60_000,
  });
  return (query.data?.commands ?? []).map((c) => ({
    name: c.name,
    description: c.input?.hint
      ? `${c.description} · ${c.input.hint}`
      : c.description,
  }));
}
```

Delete `use-harness-skills.ts`. In `harness-pane.tsx`: `import { useHarnessCommands } from "./use-harness-commands";`, `const commands = useHarnessCommands(agentId);`, and in `slashItems`:

```ts
      {
        name: "usage",
        description: "Tokens and cost this month",
        command: true,
      },
      ...commands,
    ],
    [commands]
```

In `harness-pane.test.tsx` replace the skills mock with:

```ts
vi.mock("./use-harness-commands", () => ({
  harnessCommandsQueryKey: (agentId: string | null) => [
    "harness-commands",
    agentId,
  ],
  useHarnessCommands: () => [],
}));
```

Wherever the SSE handler invalidates `harnessSkillsQueryKey` (grep `harness-skills` under `apps/web/src`), invalidate `harnessCommandsQueryKey` instead.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/use-harness-commands.test.tsx src/components/app/harness/harness-pane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src
git commit -m "feat(web): slash menu from the engine's advertised commands

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Engine marks, and a model chip that says when it cannot switch

**Files:**

- Modify: `apps/web/src/components/app/harness/provider-icon.tsx`
- Modify: `apps/web/src/components/app/harness/model-picker.tsx`
- Modify: `apps/web/src/components/app/harness/harness-pane.tsx:420-444`
- Test: `apps/web/src/components/app/harness/provider-icon.test.tsx`, `model-picker.test.tsx`

**Interfaces:**

- Consumes: `harnessEngineOf`, `HARNESS_ENGINES` from `@dispatch/shared`; `Agent.model`.
- Produces: `providerOf(id)` accepts an engine id or an `engine/model` id and returns `"anthropic" | "openai" | "google" | "opencode" | null`; `<ProviderIcon provider="opencode" />` renders a text mark; `ModelPicker` gains `fixedReason?: string | null`.

- [ ] **Step 1: Write the failing tests**

In `provider-icon.test.tsx` replace the body with:

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderIcon, providerOf } from "./provider-icon";

describe("providerOf", () => {
  it("maps engines and engine-prefixed model ids to marks", () => {
    expect(providerOf("claude")).toBe("anthropic");
    expect(providerOf("claude/claude-opus-5")).toBe("anthropic");
    expect(providerOf("codex/gpt-5.6-sol")).toBe("openai");
    expect(providerOf("gemini/default")).toBe("google");
    expect(providerOf("opencode/anthropic/claude-sonnet-5")).toBe("opencode");
    expect(providerOf("deepseek/x")).toBeNull();
    expect(providerOf(null)).toBeNull();
  });
});

describe("ProviderIcon", () => {
  it("draws an svg for vendors with a mark and a text badge for OpenCode", () => {
    render(<ProviderIcon provider="codex" />);
    expect(screen.getByTestId("provider-icon")).toHaveAttribute(
      "data-provider",
      "openai"
    );
    render(<ProviderIcon provider="opencode" />);
    expect(screen.getByText("OC")).toHaveAttribute("data-provider", "opencode");
  });
});
```

In `model-picker.test.tsx` add:

```tsx
it("explains and disables the selects when the engine fixes its model at launch", () => {
  render(
    <ModelPicker
      open
      onOpenChange={() => {}}
      model={undefined}
      effort={undefined}
      running
      saving={false}
      error={null}
      fixedReason="Gemini CLI sets its model at launch."
      onApply={async () => {}}
    />
  );
  expect(
    screen.getByText("Gemini CLI sets its model at launch.")
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /apply/i })).toBeDisabled();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/provider-icon.test.tsx src/components/app/harness/model-picker.test.tsx`
Expected: FAIL: `providerOf("claude")` is null; `fixedReason` is not a prop.

- [ ] **Step 3: Rewrite `provider-icon.tsx`**

Delete the `deepseek` entry from `MARKS` and its attribution in the header comment (keep OpenAI from LobeHub, Anthropic and Gemini from simple-icons). Replace `ALIASES`, `providerOf`, and `providerOfConfigValue` with:

```ts
/** Engine id (or an engine-prefixed model id) to the mark it wears. */
const ENGINE_MARK: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
  opencode: "opencode",
};

/** The mark for an engine id or an `engine/model` id; null when unknown. */
export function providerOf(id: string | null | undefined): string | null {
  if (!id) return null;
  const engine = id.includes("/") ? id.slice(0, id.indexOf("/")) : id;
  const mark = ENGINE_MARK[engine];
  return mark && (mark in MARKS || mark === "opencode") ? mark : null;
}
```

and extend `ProviderIcon` to draw OpenCode as text:

```tsx
export function ProviderIcon({
  provider,
  className,
}: {
  provider: string | null | undefined;
  className?: string;
}): JSX.Element | null {
  const id = providerOf(provider);
  if (id === "opencode") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-3 shrink-0 items-center text-[8px] font-semibold tracking-[0.08em]",
          className
        )}
        data-testid="provider-icon"
        data-provider="opencode"
      >
        OC
      </span>
    );
  }
  const mark = id ? MARKS[id] : undefined;
  if (!mark) return null;
  // ...the existing svg render, unchanged
}
```

Delete `providerOfConfigValue` (the chip reads the engine from the agent now).

- [ ] **Step 4: The chip and the picker**

`model-picker.tsx`: add `fixedReason?: string | null;` to `ModelPickerProps`, and use it:

```tsx
const canApply =
  running && !fixedReason && !saving && (modelChanged || effortChanged);
```

```tsx
<DialogDescription>
  {fixedReason
    ? fixedReason
    : running
      ? "Applies to the next turn of this session."
      : "The agent has no live session; start it to change these."}
</DialogDescription>
```

and pass `disabled={!running || !!fixedReason || saving}` to both `Select`s. Reword the component comment: "Both selects are fed by the session's own config options, so what is listed is what the engine will accept."

`harness-pane.tsx`: derive the engine and the chip state:

```ts
import { harnessEngineOf } from "@dispatch/shared";
// ...
const engine = harnessEngineOf(agent?.model);
const fixedReason =
  engine && !engine.publishesModelOption
    ? `${engine.label} sets its model at launch.`
    : null;
const launchModel = agent?.model?.includes("/")
  ? agent.model.slice(agent.model.indexOf("/") + 1)
  : null;
```

and the chip:

```tsx
<button
  type="button"
  onClick={() => setPickerOpen(true)}
  title={fixedReason ?? "Model and reasoning effort (or type /model)"}
  data-testid="harness-model-chip"
  data-fixed={fixedReason ? "true" : undefined}
  className={cn(CHIP_CLASS, "max-w-full", fixedReason && "opacity-70")}
>
  {starting || (!config.running && agent?.status === "running") ? (
    <ActivityBars size={10} className="shrink-0" />
  ) : (
    (<ProviderIcon provider={engine?.id} /> ?? (
      <Cpu className="h-3 w-3 shrink-0" aria-hidden="true" />
    ))
  )}
  <span className="truncate">
    {fixedReason
      ? `${launchModel === "default" || !launchModel ? engine?.label : launchModel} · fixed`
      : config.running
        ? `${modelName ?? "model"}${effortName ? ` · ${effortName.toLowerCase()}` : ""}`
        : starting || agent?.status === "running"
          ? "starting…"
          : "model · not running"}
  </span>
</button>
```

(`??` on a JSX element does not work; write it as `engine ? <ProviderIcon provider={engine.id} /> : <Cpu ... />`.) Pass `fixedReason={fixedReason}` to `<ModelPicker>`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/provider-icon.test.tsx src/components/app/harness/model-picker.test.tsx src/components/app/harness/harness-pane.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A apps/web/src/components/app/harness
git commit -m "feat(web): engine marks on the model chip, disabled with a reason when the engine fixes its model

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Usage by engine, budgets by engine

**Files:**

- Modify: `apps/web/src/components/app/harness/usage-dialog.tsx`
- Modify: `apps/web/src/components/app/harness/use-harness-usage.ts` (comment only)
- Modify: `apps/web/src/components/app/usage-budget-settings.tsx`
- Test: `apps/web/src/components/app/harness/usage-dialog.test.tsx`, `apps/web/src/components/app/usage-budget-settings.test.tsx`

**Interfaces:**

- Consumes: `HarnessUsageResponse { generatedAt; monthStart; engines: HarnessUsageEngine[] }`, `HARNESS_BUDGET_ENGINE_IDS`, `HARNESS_ENGINES`, `UsageBudgets` keyed by engine id.

- [ ] **Step 1: Write the failing tests**

Replace `usage-dialog.test.tsx`'s fixtures and assertions with:

```tsx
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { HarnessUsageResponse } from "@dispatch/shared";
import { describe, expect, it, vi } from "vitest";

import { UsageDialog, formatTokens, formatUsd } from "./usage-dialog";

const report: HarnessUsageResponse = {
  generatedAt: "2026-09-07T12:00:00.000Z",
  monthStart: "2026-09-01T00:00:00.000Z",
  engines: [
    {
      id: "claude",
      label: "Claude Code",
      publishesPlan: true,
      publishesModelOption: true,
      reportsUsage: true,
      reportsCost: true,
      loginCommand: "claude /login",
      tokens: 1_200_000,
      costUsd: 14.5,
      budgetUsd: 20,
      agents: [
        { agentId: "a", name: "Docs bot", tokens: 1_200_000, costUsd: 14.5 },
      ],
    },
    {
      id: "codex",
      label: "Codex",
      publishesPlan: true,
      publishesModelOption: true,
      reportsUsage: true,
      reportsCost: false,
      loginCommand: "codex login --device-auth",
      tokens: 55_000,
      costUsd: null,
      budgetUsd: null,
      agents: [{ agentId: "b", name: "Fixer", tokens: 55_000, costUsd: null }],
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      publishesPlan: false,
      publishesModelOption: false,
      reportsUsage: false,
      reportsCost: false,
      loginCommand: "NO_BROWSER=true gemini",
      tokens: 0,
      costUsd: null,
      budgetUsd: null,
      agents: [{ agentId: "c", name: "Gem", tokens: 0, costUsd: null }],
    },
    {
      id: "opencode",
      label: "OpenCode",
      publishesPlan: false,
      publishesModelOption: true,
      reportsUsage: true,
      reportsCost: true,
      loginCommand: "opencode auth login",
      tokens: 0,
      costUsd: null,
      budgetUsd: null,
      agents: [],
    },
  ],
};

vi.mock("./use-harness-usage", () => ({
  HARNESS_USAGE_QUERY_KEY: ["harness-usage"],
  useHarnessUsage: () => ({
    data: report,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    isFetching: false,
  }),
}));

function renderDialog() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <UsageDialog open onOpenChange={() => {}} />
    </QueryClientProvider>
  );
}

describe("UsageDialog", () => {
  it("shows one row per engine with tokens, cost where reported, and a budget bar where set", () => {
    renderDialog();
    const claude = screen.getByTestId("harness-usage-engine-claude");
    expect(within(claude).getByText("1.2M")).toBeInTheDocument();
    expect(within(claude).getByText("$14.50")).toBeInTheDocument();
    expect(within(claude).getByTestId("harness-usage-bar")).toHaveAttribute(
      "data-pct",
      "73"
    );
    const codex = screen.getByTestId("harness-usage-engine-codex");
    expect(within(codex).getByText("55k")).toBeInTheDocument();
    expect(within(codex).getByText("no cost reported")).toBeInTheDocument();
    expect(within(codex).queryByTestId("harness-usage-bar")).toBeNull();
    const gemini = screen.getByTestId("harness-usage-engine-gemini");
    expect(
      within(gemini).getByText("not reported over ACP")
    ).toBeInTheDocument();
    const opencode = screen.getByTestId("harness-usage-engine-opencode");
    expect(
      within(opencode).getByText("no agents this month")
    ).toBeInTheDocument();
  });

  it("lists the agents under an engine", () => {
    renderDialog();
    expect(
      within(screen.getByTestId("harness-usage-engine-claude")).getByText(
        "Docs bot"
      )
    ).toBeInTheDocument();
  });
});

describe("formatters", () => {
  it("format tokens and dollars", () => {
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(55_000)).toBe("55k");
    expect(formatUsd(14.5)).toBe("$14.50");
    expect(formatUsd(120)).toBe("$120");
  });
});
```

In `usage-budget-settings.test.tsx`, replace provider ids with engine ids: the dropdown offers `Claude Code` and `OpenCode` only; a saved `{ claude: 20 }` renders one row labeled "Claude Code" with `20`; adding OpenCode and committing `5` posts `{ claude: 20, opencode: 5 }`. Keep the existing ordering and dirty-state tests, changing ids and labels only.

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/usage-dialog.test.tsx src/components/app/usage-budget-settings.test.tsx`
Expected: FAIL: the dialog reads `providers`; budgets read `HARNESS_BUDGET_PROVIDERS`.

- [ ] **Step 3: Rewrite the dialog body**

In `usage-dialog.tsx` keep `formatUsd`, `formatTokens`, `BudgetBar`, and the dialog shell; delete `totalTokens`, `spendOf`, `resetsIn`, and every subscription/balance/billed render. Import `type HarnessUsageEngine` from `@dispatch/shared`. The list becomes:

```tsx
function EngineRow({ engine }: { engine: HarnessUsageEngine }): JSX.Element {
  const cost = engine.costUsd;
  return (
    <section
      className="space-y-1.5 rounded-md border border-border/60 px-3 py-2"
      data-testid={`harness-usage-engine-${engine.id}`}
    >
      <div className="flex items-center gap-2 text-[12px]">
        <ProviderIcon provider={engine.id} />
        <span className="font-medium text-foreground">{engine.label}</span>
        <span className="ml-auto tabular-nums text-muted-foreground">
          {engine.reportsUsage
            ? formatTokens(engine.tokens)
            : "not reported over ACP"}
        </span>
        {engine.reportsUsage ? (
          <span className="tabular-nums text-foreground">
            {cost !== null ? formatUsd(cost) : "no cost reported"}
          </span>
        ) : null}
      </div>
      {cost !== null && engine.budgetUsd ? (
        <BudgetBar
          spent={cost}
          budget={engine.budgetUsd}
          label={engine.label}
        />
      ) : null}
      {engine.agents.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          no agents this month
        </p>
      ) : (
        <ul className="space-y-0.5 pl-5 text-[11px] text-muted-foreground">
          {engine.agents.map((a) => (
            <li key={a.agentId} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate text-foreground/80">
                {a.name}
              </span>
              {engine.reportsUsage ? (
                <span className="tabular-nums">{formatTokens(a.tokens)}</span>
              ) : null}
              {a.costUsd !== null ? (
                <span className="tabular-nums">{formatUsd(a.costUsd)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

and the dialog content maps `data.engines` to `<EngineRow>`, with the header "Usage this month" and the description `since ${new Date(data.monthStart).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })} (UTC)`. Keep the refresh button. `use-harness-usage.ts`'s comment becomes "The engines' tokens and cost this month; fetched while the dialog is open."

`usage-budget-settings.tsx`:

```ts
import {
  HARNESS_BUDGET_ENGINE_IDS,
  HARNESS_ENGINES,
  type HarnessEngineId,
  type UsageBudgets,
} from "@dispatch/shared";

type Row = { id: HarnessEngineId; amount: string };

function labelOf(id: HarnessEngineId): string {
  return HARNESS_ENGINES.find((e) => e.id === id)?.label ?? id;
}

function rowsFrom(budgets: UsageBudgets): Row[] {
  return HARNESS_BUDGET_ENGINE_IDS.filter(
    (id) => budgets[id] !== undefined
  ).map((id) => ({ id, amount: String(budgets[id]) }));
}
```

Replace every other `HARNESS_BUDGET_PROVIDERS`/`HarnessBudgetProviderId` use with `HARNESS_BUDGET_ENGINE_IDS`/`HarnessEngineId`; the component comment becomes "Monthly spend budgets per engine that reports cost."

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/usage-dialog.test.tsx src/components/app/usage-budget-settings.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src
git commit -m "feat(web): usage and budgets by engine

One row per engine: tokens where the engine reports usage, USD where it
reports cost, a bar where a budget is set, and plain words where an
engine sends nothing over ACP. Provider billing, plan windows and
balances are gone.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Starting screen login hint, labels, and the shared cleanup

**Files:**

- Modify: `apps/web/src/components/app/harness/harness-pane.tsx:382-408`
- Modify: `apps/web/src/components/app/agent-type-settings.tsx:21-22`
- Modify: `packages/shared/src/harness-types.ts` (delete the `@deprecated` block from plan 1)
- Test: `apps/web/src/components/app/harness/harness-pane.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `harness-pane.test.tsx` (using its existing `renderPane(agent)` helper; if the helper takes an `Agent`, build one with `status: "error"`):

```tsx
it("names the login command when the engine reports it is not logged in", () => {
  renderPane({
    ...baseAgent,
    status: "error",
    model: "codex/default",
    latestEvent: {
      type: "blocked",
      message: "Codex is not logged in on the server.",
      updatedAt: "2026-09-07T12:00:00.000Z",
    },
  });
  expect(screen.getByTestId("harness-login-hint")).toHaveTextContent(
    "codex login --device-auth"
  );
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/harness-pane.test.tsx`
Expected: FAIL: no `harness-login-hint`.

- [ ] **Step 3: Render the hint, fix the description, delete the deprecated types**

In `harness-pane.tsx`'s non-starting empty state, after the `<p data-testid="harness-empty">`, add:

```tsx
{
  agent?.status === "error" &&
  engine &&
  /not logged in/i.test(agent.latestEvent?.message ?? "") ? (
    <p
      className="mt-2 text-center text-[11px] text-muted-foreground"
      data-testid="harness-login-hint"
    >
      Run as the service user, then press Start:{" "}
      <code className="rounded bg-muted px-1 py-0.5 text-foreground">
        {engine.loginCommand}
      </code>
    </p>
  ) : null;
}
```

(Wrap the empty-state `<p>` and this hint in a fragment.)

`agent-type-settings.tsx`:

```ts
  dispatch:
    "Dispatch Harness: Dispatch's harness view, running Claude Code, Codex, Gemini CLI, or OpenCode over the Agent Client Protocol.",
```

`packages/shared/src/harness-types.ts`: delete `HarnessSkill`, `HarnessSkillsResponse`, `HARNESS_USAGE_PROVIDERS`, `HarnessUsageProvider`, `HarnessSubscriptionUsage`, `HarnessTokenCounts`, `harnessProviderLabel`, `isHarnessBudgetProvider`, `HARNESS_BUDGET_PROVIDERS`, `HarnessSubagent`, `HarnessSubagentResponse`, and their `@deprecated` comments; drop their lines from `packages/shared/src/index.ts`.

- [ ] **Step 4: Type check everything**

Run: `pnpm run check`
Expected: exit 0 for server, web, site, extension. Any remaining importer of a deleted type is a file this plan missed; fix it here.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src packages/shared
git commit -m "feat(web): login hint from the engine table, and the dsh-era shared types go

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The harness icon

**Files:**

- Create: `apps/web/public/harness-icon.svg` (generated)
- Modify: `scripts/generate-icon-colors.ts`
- Modify: `apps/web/src/components/app/agent-type-icon.tsx:158-175`
- Generated: `apps/web/public/icons/<color>/harness-icon.svg` for every palette color
- Test: `apps/web/src/components/app/agent-type-icon.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentTypeIcon } from "./agent-type-icon";

vi.mock("@/hooks/use-icon-color", () => ({
  useIconColor: () => ({ iconColor: "emerald" }),
}));

describe("AgentTypeIcon for the Dispatch Harness", () => {
  it("wears the harness icon in the chosen color", () => {
    render(<AgentTypeIcon type="dispatch" />);
    const img = screen.getByLabelText("Dispatch agent").querySelector("img");
    expect(img).toHaveAttribute("src", "/icons/emerald/harness-icon.svg");
  });
});
```

(Use whatever palette id `ICON_COLOR_PALETTE` actually has first; `emerald` is a guess to replace with the first `id` in `apps/server/src/shared/icon-colors.ts`.)

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/agent-type-icon.test.tsx`
Expected: FAIL: src is `/icons/<color>/brand-icon.svg`.

- [ ] **Step 3: Generate the icon**

Add to `scripts/generate-icon-colors.ts` after the constants:

```ts
const HARNESS_ICON_PATH = path.join(PUBLIC_DIR, "harness-icon.svg");

/**
 * The harness icon: the brand mark at 62% inside a ring in the dark brand
 * color. The ring is what reads at 20px next to the brand mark in the
 * sidebar. Built from brand-icon.svg so a brand change carries over.
 */
function buildHarnessIcon(brandSvg: string): string {
  const inner = extractSvgContent(brandSvg);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
<circle cx="150" cy="150" r="138" fill="none" stroke="${ORIGINAL_DARK}" stroke-width="14"/>
<g transform="translate(57, 61) scale(0.62)">
${inner}
</g>
</svg>
`;
}
```

In `main()`, after reading `brandSvg`, write the source icon once and recolor it per palette entry:

```ts
  const harnessSvg = buildHarnessIcon(brandSvg);
  fs.writeFileSync(HARNESS_ICON_PATH, harnessSvg);

  for (const color of COLORS) {
    // ...existing brand-icon and full-logo writes...
    fs.writeFileSync(
      path.join(colorDir, "harness-icon.svg"),
      harnessSvg
        .replaceAll(ORIGINAL_PRIMARY, color.primary)
        .replaceAll(ORIGINAL_DARK, color.dark)
    );
```

Update the file's header comment to mention `harness-icon.svg`. Run it:

```bash
cd /home/nii/.dispatch/server-dsh-harness && npx tsx scripts/generate-icon-colors.ts
ls apps/web/public/harness-icon.svg apps/web/public/icons/*/harness-icon.svg | wc -l
```

Expected: one source file plus one per palette color.

`agent-type-icon.tsx`, in `DispatchHarnessMark`:

```tsx
<img
  src={`/icons/${iconColor}/harness-icon.svg`}
  alt=""
  className="h-3.5 w-3.5 object-contain"
  aria-hidden="true"
/>
```

and its comment: "The Dispatch Harness wears the harness icon: the brand mark inside a ring, in the icon color the user picked for the sidebar."

- [ ] **Step 4: Run the test to see it pass**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/agent-type-icon.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-icon-colors.ts apps/web/public/harness-icon.svg apps/web/public/icons apps/web/src/components/app/agent-type-icon.tsx apps/web/src/components/app/agent-type-icon.test.tsx
git commit -m "feat(web): a harness icon, the brand mark in a ring

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Motion tokens, reduced motion, and the rows

**Files:**

- Create: `apps/web/src/components/app/harness/motion.ts`
- Modify: `apps/web/src/components/app/harness/harness-pane.tsx` (root `MotionConfig`)
- Modify: `apps/web/src/components/app/harness/activity-block.tsx:99-108`
- Modify: `apps/web/src/components/app/harness/step-row.tsx:113-120`
- Modify: `apps/web/src/components/app/harness/result-turn.tsx:24-27`
- Test: `apps/web/src/components/app/harness/motion.test.ts` (new)

**Interfaces:**

- Produces:

```ts
export const DURATION = { fast: 0.12, base: 0.2, slow: 0.32 } as const; // seconds, framer units
export const EASE = { standard: [0.2, 0, 0, 1], exit: [0.4, 0, 1, 1] } as const;
export const STAGGER_S = 0.02;
export const STAGGER_CAP = 5;
export function rowDelay(indexInBurst: number): number; // min(index, cap) * STAGGER_S
export const rowVariants: Variants; // hidden: {opacity:0, y:4}; shown: {opacity:1, y:0}
export const fadeVariants: Variants; // hidden: {opacity:0}; shown: {opacity:1}
export const exitShrink: TargetAndTransition; // {opacity:0, height:0, transition:{duration: fast, ease: exit}}
```

- [ ] **Step 1: Write the failing test**

Create `motion.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { DURATION, EASE, rowDelay, STAGGER_CAP, STAGGER_S } from "./motion";

describe("motion tokens", () => {
  it("has the three durations and two easings from the spec", () => {
    expect(DURATION).toEqual({ fast: 0.12, base: 0.2, slow: 0.32 });
    expect(EASE.standard).toEqual([0.2, 0, 0, 1]);
    expect(EASE.exit).toEqual([0.4, 0, 1, 1]);
  });
  it("staggers rows 20 ms apart, capped at five", () => {
    expect(rowDelay(0)).toBe(0);
    expect(rowDelay(2)).toBeCloseTo(2 * STAGGER_S);
    expect(rowDelay(40)).toBeCloseTo(STAGGER_CAP * STAGGER_S);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/motion.test.ts`
Expected: FAIL: module not found.

- [ ] **Step 3: Write the tokens and apply them to rows and results**

Create `motion.ts`:

```ts
import type { TargetAndTransition, Variants } from "framer-motion";

/**
 * The harness's motion tokens: the only place a duration or easing is
 * written. Every transition in this directory reads from here, and
 * `MotionConfig reducedMotion="user"` at the pane root collapses all of it
 * for readers who asked for less motion.
 */
export const DURATION = { fast: 0.12, base: 0.2, slow: 0.32 } as const;

export const EASE = {
  standard: [0.2, 0, 0, 1],
  exit: [0.4, 0, 1, 1],
} as const;

/** Rows that land in the same tick stagger this far apart, up to the cap. */
export const STAGGER_S = 0.02;
export const STAGGER_CAP = 5;

export function rowDelay(indexInBurst: number): number {
  return Math.min(Math.max(indexInBurst, 0), STAGGER_CAP) * STAGGER_S;
}

/** A step row landing: rise 4px and fade in. */
export const rowVariants: Variants = {
  hidden: { opacity: 0, y: 4 },
  shown: { opacity: 1, y: 0 },
};

export const fadeVariants: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1 },
};

/** Something leaving: fade and shrink, on the exit easing. */
export const exitShrink: TargetAndTransition = {
  opacity: 0,
  height: 0,
  transition: { duration: DURATION.fast, ease: EASE.exit },
};

export const arrive = (duration: number = DURATION.base) => ({
  duration,
  ease: EASE.standard,
});
```

`harness-pane.tsx`: `import { MotionConfig } from "framer-motion";` and wrap the pane's root `<div ref={dropRef} ...>` in `<MotionConfig reducedMotion="user">…</MotionConfig>`.

`step-row.tsx`: `import { motion } from "framer-motion";` and `import { arrive, rowDelay, rowVariants } from "./motion";`; add an `index?: number` prop (default 0) and replace the wrapper:

```tsx
    <motion.div
      variants={rowVariants}
      initial="hidden"
      animate="shown"
      transition={{ ...arrive(), delay: rowDelay(index) }}
      role="listitem"
      aria-live={running ? "polite" : undefined}
      data-testid="harness-step"
      data-depth={depth}
      data-expandable={expandable ? "true" : "false"}
    >
```

(`animate-harness-row motion-reduce:animate-none` is gone.) In `activity-block.tsx` pass the burst index: rows that share a `startedAt` second get consecutive indexes; simplest correct rule is the step's position among steps that started within 50 ms of it:

```tsx
{
  trace.steps.map((step, i) => (
    <StepRow
      key={step.id}
      step={step}
      index={burstIndex(trace.steps, i)}
      open={stepOpen(step)}
      onToggle={() => toggleStep(step)}
      maskClass={BLOCK_FILL}
    />
  ));
}
```

with, in `motion.ts`:

```ts
/** How many earlier rows started within 50 ms of this one: its slot in the burst. */
export function burstIndex(
  steps: readonly { startedAt: number }[],
  i: number
): number {
  let n = 0;
  for (
    let j = i - 1;
    j >= 0 && steps[i].startedAt - steps[j].startedAt <= 50;
    j -= 1
  )
    n += 1;
  return n;
}
```

`result-turn.tsx`: replace the `animate-harness-msg` wrapper with `motion.div variants={fadeVariants} initial="hidden" animate="shown" transition={arrive()}`. The `CollapsedSummary` in `activity-block.tsx` drops `animate-harness-row motion-reduce:animate-none` from its class (Task 10 animates it).

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/motion.test.ts src/components/app/harness/step-row.test.tsx src/components/app/harness/harness-pane.test.tsx`
Expected: PASS. (Tests that render `StepRow` outside a `MotionConfig` still pass: framer animates in jsdom without layout.)

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src/components/app/harness
git commit -m "feat(web): harness motion tokens, reduced-motion config, staggered rows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The fold, the status word, and the queue

**Files:**

- Modify: `apps/web/src/components/app/harness/activity-block.tsx`
- Modify: `apps/web/src/components/app/harness/turn-stream.tsx:196-204`
- Modify: `apps/web/src/components/app/harness/queued-prompt.tsx:32-37`
- Test: `apps/web/src/components/app/harness/activity-block.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import { describe, expect, it } from "vitest";

import { ActivityBlock } from "./activity-block";
import type { Trace } from "./contracts";

const at = Date.parse("2026-09-07T10:00:00Z");
const open: Trace = {
  startedAt: at,
  steps: [
    {
      id: "s",
      kind: "read",
      label: "Read",
      status: "ok",
      startedAt: at,
      endedAt: at + 500,
      durMs: 500,
    },
  ],
};
const done: Trace = { ...open, endedAt: at + 1000, finalResult: "ok" };

describe("ActivityBlock settle", () => {
  it("renders the open rail while running and the collapsed summary once settled, both inside one layout group", () => {
    const { rerender } = render(
      <MotionConfig reducedMotion="always">
        <ActivityBlock trace={open} />
      </MotionConfig>
    );
    expect(screen.getByTestId("harness-activity")).toBeInTheDocument();
    rerender(
      <MotionConfig reducedMotion="always">
        <ActivityBlock trace={done} label="read a.ts" />
      </MotionConfig>
    );
    expect(screen.getByTestId("harness-activity-summary")).toHaveTextContent(
      "read a.ts"
    );
    expect(screen.getByTestId("harness-activity-fold")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/activity-block.test.tsx`
Expected: FAIL: no `harness-activity-fold`.

- [ ] **Step 3: Animate the fold, the status word, and the queue**

`activity-block.tsx`: import `AnimatePresence, motion` from framer and `arrive, DURATION, EASE, fadeVariants` from `./motion`. Wrap the two states in one animated container so the settle folds from the measured open height:

```tsx
return (
  <motion.div
    layout
    transition={arrive(DURATION.slow)}
    data-testid="harness-activity-fold"
  >
    <AnimatePresence mode="wait" initial={false}>
      {done && !open ? (
        <motion.div
          key="summary"
          variants={fadeVariants}
          initial="hidden"
          animate="shown"
          exit="hidden"
          transition={arrive(DURATION.fast)}
        >
          <CollapsedSummary
            trace={trace}
            label={label}
            onExpand={handleExpand}
            buttonRef={summaryButtonRef}
          />
        </motion.div>
      ) : (
        <motion.div
          key="open"
          variants={fadeVariants}
          initial="hidden"
          animate="shown"
          exit="hidden"
          transition={arrive(DURATION.fast)}
          className={cn(
            "rounded-md border border-border/60 px-3 py-2.5",
            BLOCK_FILL
          )}
          data-testid="harness-activity"
        >
          {/* BlockHeader + rail, unchanged */}
        </motion.div>
      )}
    </AnimatePresence>
  </motion.div>
);
```

(Move the early `return <CollapsedSummary …/>` into this structure; `handleExpand`/`handleCollapse` stay.) In `BlockHeader`, the status word cross-fades when it changes:

```tsx
<AnimatePresence mode="wait" initial={false}>
  <motion.span
    key={label}
    variants={fadeVariants}
    initial="hidden"
    animate="shown"
    exit="hidden"
    transition={arrive(DURATION.fast)}
    className={cn(
      "text-[12px]",
      done ? "text-foreground" : "font-medium text-status-working"
    )}
  >
    {label}
  </motion.span>
</AnimatePresence>
```

and the running tint on the open block eases out: give the open `motion.div` `animate={{ borderColor: done ? "hsl(var(--border) / 0.6)" : "hsl(var(--status-working) / 0.35)" }}` with `transition={arrive()}`.

`turn-stream.tsx`: wrap the queue in `AnimatePresence` and let siblings close the gap:

```tsx
<AnimatePresence initial={false}>
  {queued?.map((prompt) => (
    <motion.div
      key={prompt.id}
      layout
      variants={rowVariants}
      initial="hidden"
      animate="shown"
      exit={exitShrink}
      transition={arrive()}
      style={{ overflow: "hidden" }}
    >
      <QueuedPrompt
        prompt={prompt}
        busy={queueBusyId === prompt.id}
        onSendNow={onSendNow}
        onRemove={onRemoveQueued}
      />
    </motion.div>
  ))}
</AnimatePresence>
```

(`queued-prompt.tsx` keeps its markup; its outer `mb-3.5` moves onto the wrapper's className so the exit shrinks the margin too.)

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/activity-block.test.tsx src/components/app/harness/harness-pane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src/components/app/harness
git commit -m "feat(web): the turn fold, status word and queue move on the motion tokens

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Tasks strip, model chip, and the starting-screen handoff

**Files:**

- Modify: `apps/web/src/components/app/harness/tasks-strip.tsx`
- Modify: `apps/web/src/components/app/harness/todo-list.tsx`
- Modify: `apps/web/src/components/app/harness/harness-pane.tsx` (chip label, empty state)
- Test: `apps/web/src/components/app/harness/harness-pane.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `harness-pane.test.tsx`:

```tsx
it("mounts the tasks strip inside a presence wrapper and animates the chip label by key", () => {
  state.turns = [
    { id: "u", role: "user", content: "go", timestamp: 1 },
    {
      id: "a",
      role: "assistant",
      content: "",
      timestamp: 2,
      trace: { startedAt: 1, endedAt: 2, steps: [] },
      extra: {
        plan: [{ content: "b", status: "in_progress", priority: "low" }],
      },
    },
  ];
  renderPane(baseAgent);
  expect(screen.getByTestId("harness-tasks-presence")).toBeInTheDocument();
  expect(screen.getByTestId("harness-tasks")).toHaveTextContent("0 of 1 done");
  expect(screen.getByTestId("harness-model-chip-label")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness/harness-pane.test.tsx`
Expected: FAIL: no `harness-tasks-presence`, no `harness-model-chip-label`.

- [ ] **Step 3: Apply the last three moments**

`harness-pane.tsx`: wrap the strip:

```tsx
<AnimatePresence initial={false}>
  {tasksOpen ? (
    <motion.div
      key="tasks"
      data-testid="harness-tasks-presence"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={exitShrink}
      transition={arrive()}
      style={{ overflow: "hidden" }}
    >
      <TasksStrip
        items={currentTasks}
        open={tasksExpanded}
        onOpenChange={setTasksExpanded}
      />
    </motion.div>
  ) : null}
</AnimatePresence>
```

The chip label cross-fades by its text:

```tsx
<AnimatePresence mode="wait" initial={false}>
  <motion.span
    key={chipLabel}
    data-testid="harness-model-chip-label"
    className="truncate"
    variants={fadeVariants}
    initial="hidden"
    animate="shown"
    exit="hidden"
    transition={arrive(DURATION.fast)}
  >
    {chipLabel}
  </motion.span>
</AnimatePresence>
```

where `chipLabel` is the string the chip computed in Task 5, hoisted into a `const`. The starting screen hands off to the composer in one shared transition: wrap the `TurnStream` `emptyState`'s two branches in `AnimatePresence mode="wait"` with `motion.div` keyed `"starting"` / `"ready"`, `variants={fadeVariants}`, `transition={arrive(DURATION.slow)}`, and give the composer's container `motion.div` `initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={arrive(DURATION.slow)}` keyed on `starting` so it rises in as the bars fade out.

`todo-list.tsx`: each `<li>` becomes `motion.li layout` with `transition={arrive()}`, and the status glyph cross-fades with `AnimatePresence mode="wait"` keyed by `item.status` at `DURATION.fast`; `tasks-strip.tsx` needs no change beyond importing nothing new.

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/components/app/harness`
Expected: PASS for the whole directory.

- [ ] **Step 5: Remove the dead keyframes and commit**

In `apps/web/tailwind.config.ts` delete the `harness-row`, `harness-msg`, and `harness-pop` keyframes and their three `animation` entries (the `✓` pop in `StatusGlyph` becomes a `motion.span` with `initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={arrive(DURATION.fast)}`). Then:

```bash
grep -rn -E 'animate-harness|harness-row|harness-msg|harness-pop|duration-[0-9]|ease-\[' apps/web/src/components/app/harness apps/web/tailwind.config.ts
```

Expected: no output (the `grid-template-rows` fold in `step-row.tsx` becomes `motion.div animate={{ height: expanded ? "auto" : 0 }} transition={arrive()}` with `style={{ overflow: "hidden" }}`, and `FOLD_MS` becomes `DURATION.base * 1000`).

```bash
git add -A apps/web
git commit -m "feat(web): tasks strip, chip label and starting screen on the motion tokens; dead keyframes removed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Web gate

- [ ] **Step 1: Nothing dsh remains in the web**

First rename the fixture group labels in `apps/web/src/components/app/agent-model-select.test.tsx` from `"DeepSeek"` to `"Gemini CLI"` and from `"OpenAI"` to `"Codex"` (they are grouping fixtures; the assertions on group order and membership stay). Then:

Run: `grep -rniE '\bdsh\b|deepseek|provider key|openai-codex' apps/web/src packages/shared/src`
Expected: no output.

- [ ] **Step 2: Type check, tests, production build**

Run: `pnpm run check`
Expected: exit 0.

Run: `cd apps/web && NODE_OPTIONS=--no-experimental-webstorage npx vitest run`
Expected: all green.

Run: `pnpm run finalize:web`
Expected: type check and `vite build` succeed.

- [ ] **Step 3: Manual motion pass**

Start an isolated stack (`repo_dev_up`), open a `dispatch` agent, and watch each row of the spec's Motion table once at normal speed: a row landing, a turn settling, a queued message added and removed, Stop, the tasks strip mounting, the chip changing, the starting screen handing off. Then toggle the OS reduced-motion setting and confirm nothing moves. Record what you saw in the commit message of any fix.

---

## Self-review against the spec

| Spec section                                                      | Task                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web table: tasks strip from `plan`                                | 1, 2                                                                                                                                                                                                                                            |
| Web table: `use-harness-commands`                                 | 4                                                                                                                                                                                                                                               |
| Web table: four marks, engine grouping, disabled chip with reason | 5                                                                                                                                                                                                                                               |
| Web table: usage dialog, budgets                                  | 6                                                                                                                                                                                                                                               |
| Web table: nested steps, no child fetch                           | 3                                                                                                                                                                                                                                               |
| Web table: goal strip deleted                                     | 2                                                                                                                                                                                                                                               |
| Web table: Console plain shell                                    | plan 3 checks it; no web file changes the Console since the command-log split was a server-fed tail (`command-log.ts`, deleted in plan 1). If a web component still references a harness log route after plan 1, plan 3 Task 1's grep finds it. |
| Web table: starting screen `auth_required` message                | 7                                                                                                                                                                                                                                               |
| Web table: labels and description                                 | 7                                                                                                                                                                                                                                               |
| Icon                                                              | 8                                                                                                                                                                                                                                               |
| Motion: tokens, moments, rules, tests                             | 9, 10, 11, 12                                                                                                                                                                                                                                   |
| Errors: login command from `HARNESS_ENGINES`                      | 7                                                                                                                                                                                                                                               |

Placeholder scan: none. Type consistency: `latestPlanItems`, `hasChildren`, `useHarnessCommands`, `providerOf`, `fixedReason`, `rowDelay`, `burstIndex`, `arrive`, `fadeVariants`, `rowVariants`, `exitShrink` are used with the same names throughout.
