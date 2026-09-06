// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessQueuedPrompt, HarnessQuestion } from "@dispatch/shared";

import type { Agent } from "@/components/app/types";

import type { Trace, Turn } from "./contracts";
import { HarnessPane } from "./harness-pane";

const state: {
  turns: Turn[];
  liveTrace: Trace | null;
  liveText: string;
  liveQuestions: HarnessQuestion[];
  streaming: boolean;
  queued: HarnessQueuedPrompt[];
  promptHistory: string[];
  loading: boolean;
  error: Error | null;
} = {
  turns: [],
  liveTrace: null,
  liveText: "",
  liveQuestions: [],
  streaming: false,
  queued: [],
  promptHistory: [],
  loading: false,
  error: null,
};

vi.mock("./use-harness-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./use-harness-config")>()),
  useHarnessConfig: () => ({
    running: false,
    options: [],
    model: undefined,
    effort: undefined,
    loading: false,
  }),
  useSetHarnessConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("./use-harness-skills", () => ({
  harnessSkillsQueryKey: (agentId: string | null) => [
    "harness-skills",
    agentId,
  ],
  useHarnessSkills: () => [],
}));
vi.mock("./use-harness-turns", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./use-harness-turns")>()),
  useHarnessTurns: () => state,
}));
const subagentState: {
  subagent: unknown;
  loading: boolean;
  error: Error | null;
} = {
  subagent: null,
  loading: false,
  error: null,
};
vi.mock("./use-harness-subagent", () => ({
  harnessSubagentQueryKey: (a: string | null, s: string | null) => [
    "harness-subagent",
    a,
    s,
  ],
  useHarnessSubagent: () => subagentState,
}));
const runShortcut = vi.fn();
vi.mock("@/hooks/use-pin-shortcuts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-pin-shortcuts")>()),
  useRunPinShortcut: () => ({
    mutate: runShortcut,
    isPending: false,
    variables: undefined,
  }),
}));
vi.mock("@/hooks/use-coarse-pointer", () => ({
  useCoarsePointer: () => false,
}));
const queueInterrupt = vi.fn(async () => {});
const queueSendNow = vi.fn(async (_id: string) => {});
const queueRemove = vi.fn(async (_id: string) => {});
vi.mock("./use-harness-queue", () => ({
  useHarnessQueue: () => ({
    sendNow: queueSendNow,
    remove: queueRemove,
    busyId: null,
  }),
  useHarnessInterrupt: () => ({
    interrupt: queueInterrupt,
    interrupting: false,
  }),
}));
const answerMutate = vi.fn(async () => ({}));
vi.mock("@/hooks/use-chat", () => ({
  useSendChatMessage: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useAnswerChatQuestion: () => ({
    mutateAsync: answerMutate,
    isPending: false,
    variables: undefined,
  }),
}));
vi.mock("@/components/ui/markdown-mermaid", () => ({
  MermaidBlock: () => null,
}));
vi.mock("@/components/ui/markdown-mermaid-theme", () => ({
  useMermaidTheme: () => "default",
}));

const agent = {
  id: "agt_1",
  name: "worker",
  status: "running",
  type: "dispatch",
} as unknown as Agent;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient();
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  state.turns = [];
  state.liveTrace = null;
  state.liveText = "";
  state.liveQuestions = [];
  state.streaming = false;
  state.queued = [];
  state.promptHistory = [];
  answerMutate.mockClear();
  queueSendNow.mockClear();
  queueRemove.mockClear();
  queueInterrupt.mockClear();
  runShortcut.mockClear();
});

const T0 = Date.parse("2026-09-04T10:00:00.000Z");

describe("HarnessPane", () => {
  it("says so when a turn was interrupted", () => {
    state.turns = [
      { id: "t1:user", role: "user", content: "look around", timestamp: T0 },
      {
        id: "t1:assistant",
        role: "assistant",
        content: "Half way",
        timestamp: T0 + 4000,
        trace: {
          startedAt: T0,
          endedAt: T0 + 4000,
          finalResult: "interrupted",
          steps: [
            {
              id: "s1",
              kind: "execute",
              label: "bash",
              status: "ok",
              startedAt: T0 + 1000,
              endedAt: T0 + 2000,
              durMs: 1000,
              detail: { terminalOutput: "ok\n" },
            },
          ],
        },
        extra: { label: "Working on the latest message." },
      },
    ];
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    const summary = screen.getByTestId("harness-activity-summary");
    expect(summary.textContent).toContain("interrupted");
    expect(summary.getAttribute("data-final-result")).toBe("interrupted");
    expect(screen.getByTestId("harness-interrupted").textContent).toContain(
      "Interrupted mid-turn"
    );
    expect(screen.getByTestId("harness-result").textContent).toContain(
      "Half way"
    );
  });

  it("renders a settled turn as prompt, collapsed activity and result", () => {
    state.turns = [
      { id: "t1:user", role: "user", content: "look around", timestamp: T0 },
      {
        id: "t1:assistant",
        role: "assistant",
        content: "All clear.",
        timestamp: T0 + 9000,
        trace: {
          startedAt: T0,
          endedAt: T0 + 9000,
          finalResult: "ok",
          steps: [
            {
              id: "s1",
              kind: "execute",
              label: "bash",
              status: "ok",
              startedAt: T0 + 3000,
              endedAt: T0 + 5000,
              durMs: 2000,
              detail: { terminalOutput: "ok\n" },
            },
          ],
        },
      },
    ];
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    expect(screen.getByTestId("harness-prompt").textContent).toContain(
      "look around"
    );
    const summary = screen.getByTestId("harness-activity-summary");
    expect(summary.textContent).toContain("done");
    expect(summary.textContent).toContain("1 step");
    expect(screen.getByTestId("harness-result").textContent).toContain(
      "All clear."
    );
    expect(screen.queryByTestId("harness-empty")).toBeNull();
  });

  it("shows the live activity block and growing text while streaming", () => {
    state.turns = [
      { id: "t2:user", role: "user", content: "again", timestamp: T0 },
    ];
    state.liveTrace = {
      startedAt: T0,
      steps: [
        {
          id: "s2",
          kind: "read",
          label: "read",
          status: "running",
          startedAt: T0 + 1000,
        },
      ],
    };
    state.liveText = "Working on";
    state.streaming = true;
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    expect(screen.getByTestId("harness-live-activity").textContent).toContain(
      "working"
    );
    expect(screen.getByTestId("harness-live-text").textContent).toContain(
      "Working on"
    );
    expect(screen.queryByTestId("harness-result")).toBeNull();
  });

  it("shows a running thinking row while the live turn has nothing open", () => {
    vi.useFakeTimers();
    state.turns = [
      { id: "t2:user", role: "user", content: "again", timestamp: T0 },
    ];
    state.liveTrace = {
      startedAt: T0,
      steps: [
        {
          id: "s2",
          kind: "read",
          label: "read",
          status: "ok",
          startedAt: T0 + 1000,
          endedAt: T0 + 1200,
          durMs: 200,
        },
      ],
    };
    state.streaming = true;
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    // The row waits half a second so back-to-back calls do not flicker it.
    expect(screen.queryByTestId("harness-thinking-row")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    const row = screen.getByTestId("harness-thinking-row");
    expect(row.textContent).toContain("thinking");
    // A step still running is its own sign of life; no extra row then.
    state.liveTrace = {
      startedAt: T0,
      steps: [
        {
          id: "s3",
          kind: "think",
          label: "thinking",
          status: "running",
          startedAt: T0 + 1300,
        },
      ],
    };
    cleanup();
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByTestId("harness-thinking-row")).toBeNull();
    expect(screen.getAllByTestId("harness-step")[0].textContent).toContain(
      "thinking"
    );
    vi.useRealTimers();
  });

  it("invites the first prompt when there are no turns", () => {
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    expect(screen.getByTestId("harness-empty").textContent).toBe(
      "Send the first prompt."
    );
  });
});

describe("HarnessPane while the agent is starting", () => {
  it("shows the loading bars and keeps the composer closed", () => {
    const creating = {
      ...agent,
      status: "creating",
      latestEvent: { type: "working", message: "Installing dependencies…" },
    } as unknown as Agent;
    render(
      <HarnessPane agentId="agt_1" agent={creating} active isMobile={false} />,
      { wrapper }
    );
    const starting = screen.getByTestId("harness-starting");
    expect(starting.querySelector('[role="status"]')).not.toBeNull();
    expect(starting.textContent).toContain("Installing dependencies…");
    expect(screen.queryByTestId("harness-empty")).toBeNull();
    const input = screen.getByTestId(
      "chat-composer-input"
    ) as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByTestId("harness-model-chip").textContent).toContain(
      "starting"
    );
  });
});

describe("HarnessPane questions and drops", () => {
  it("renders an agent question with its options and answers on click", async () => {
    state.turns = [
      { id: "t1:user", role: "user", content: "pick", timestamp: T0 },
      {
        id: "t1:assistant",
        role: "assistant",
        content: "Which?",
        timestamp: T0 + 1000,
        trace: {
          startedAt: T0,
          endedAt: T0 + 1000,
          finalResult: "ok",
          steps: [],
        },
        extra: {
          questions: [
            {
              id: "q1",
              text: "Fix the preview alone, or bundle it?",
              options: [
                { label: "Preview only" },
                { label: "Bundle", value: "bundle" },
              ],
              allowFreeform: false,
              answer: null,
              createdAt: "2026-09-04T10:00:00.500Z",
            },
          ],
        },
      },
    ];
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    const card = screen.getByTestId("harness-question");
    expect(card.textContent).toContain("Needs your reply");
    const options = screen.getAllByTestId("harness-question-option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Preview only",
      "Bundle",
    ]);
    fireEvent.click(options[1]);
    expect(answerMutate).toHaveBeenCalledWith({
      messageId: "q1",
      value: "bundle",
      label: "Bundle",
    });
  });

  it("shows the drop overlay while files are dragged over the pane", () => {
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    const pane = screen.getByTestId("harness-pane");
    expect(screen.queryByTestId("harness-drop-overlay")).toBeNull();
    fireEvent.dragOver(pane, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.getByTestId("harness-drop-overlay")).toBeTruthy();
    fireEvent.drop(pane, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.queryByTestId("harness-drop-overlay")).toBeNull();
  });
});

describe("HarnessPane message queue", () => {
  it("lists queued prompts under the live turn with Send now and Remove", () => {
    state.turns = [
      { id: "t2:user", role: "user", content: "first", timestamp: T0 },
    ];
    state.liveTrace = { startedAt: T0, steps: [] };
    state.streaming = true;
    state.queued = [
      {
        id: "m2",
        source: "chat",
        text: "second thoughts",
        chatMessageId: "m2",
        attachments: [],
        createdAt: "2026-09-04T10:00:01.000Z",
      },
      {
        id: "q_3",
        source: "agent",
        text: "and mine",
        senderName: "Reviewer",
        attachments: [],
        createdAt: "2026-09-04T10:00:02.000Z",
      },
    ];
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    const rows = screen.getAllByTestId("harness-queued");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("second thoughts");
    expect(rows[0].textContent).toContain("Queued");
    expect(rows[1].textContent).toContain("from Reviewer");
    // The queue sits after the live turn, in order.
    const stream = screen.getByTestId("harness-stream");
    const live = screen.getByTestId("harness-live-activity");
    expect(
      live.compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(stream.contains(rows[1])).toBe(true);

    fireEvent.click(
      rows[0].querySelector('[data-testid="harness-queued-send-now"]')!
    );
    expect(queueSendNow).toHaveBeenCalledWith("m2");
    fireEvent.click(
      rows[1].querySelector('[data-testid="harness-queued-remove"]')!
    );
    expect(queueRemove).toHaveBeenCalledWith("q_3");

    // The composer says what Enter does while the agent is busy.
    expect(screen.getByTestId("chat-composer-hint").textContent).toBe(
      "Agent is working · Enter queues your message · ↑ edits the queued one · Ctrl+C stops"
    );
  });

  it("keeps the plain composer hint when nothing runs", () => {
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    expect(screen.queryByTestId("harness-queued")).toBeNull();
    expect(screen.queryByTestId("chat-composer-hint")).toBeNull();
  });
});

describe("HarnessPane tasks and subagents", () => {
  const todoStep = (status: [string, string, string]) => ({
    id: "todo-1",
    kind: "edit",
    label: "todo_write",
    status: "ok" as const,
    startedAt: T0 + 100,
    endedAt: T0 + 200,
    durMs: 100,
    detail: {
      input: {
        todos: [
          { content: "Inspect conventions", status: status[0] },
          { content: "Write the skill", status: status[1] },
          { content: "Run validation", status: status[2] },
        ],
      },
      terminalOutput:
        "Updated todo list: 1 pending, 1 in progress, 1 completed.",
    },
  });

  it("pins the live turn's task list above the composer and expands the step", () => {
    state.turns = [
      { id: "t1:user", role: "user", content: "build it", timestamp: T0 },
    ];
    state.liveTrace = {
      startedAt: T0,
      steps: [todoStep(["completed", "in_progress", "pending"])],
    };
    state.streaming = true;
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    const strip = screen.getByTestId("harness-tasks");
    expect(strip.textContent).toContain("1 of 3 done");
    // The strip previews the active item and what comes next; done items
    // are behind "+N more".
    const items = strip.querySelectorAll('[data-testid="harness-todo-item"]');
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("data-status")).toBe("in_progress");
    expect(items[0].textContent).toContain("Write the skill");
    expect(screen.getByTestId("harness-tasks-more").textContent).toBe(
      "+1 more"
    );
    fireEvent.click(screen.getByTestId("harness-tasks-more"));
    expect(
      strip.querySelectorAll('[data-testid="harness-todo-item"]')
    ).toHaveLength(3);
    // Collapsing keeps the active task in the header line.
    fireEvent.click(screen.getByTestId("harness-tasks-toggle"));
    expect(strip.querySelector('[data-testid="harness-todo-list"]')).toBeNull();
    expect(strip.textContent).toContain("Write the skill");

    // The step reads as "tasks" with progress, and expands into the list.
    const step = screen.getAllByTestId("harness-step")[0];
    expect(step.textContent).toContain("tasks");
    expect(step.getAttribute("data-expandable")).toBe("true");
    fireEvent.click(step.querySelector("button")!);
    expect(
      step.querySelector('[data-testid="harness-todo-list"]')
    ).not.toBeNull();
  });

  it("drops the strip once every task is done and the turn has settled", () => {
    state.turns = [
      { id: "t1:user", role: "user", content: "build it", timestamp: T0 },
      {
        id: "t1:assistant",
        role: "assistant",
        content: "Done.",
        timestamp: T0 + 900,
        trace: {
          startedAt: T0,
          endedAt: T0 + 900,
          finalResult: "ok",
          steps: [todoStep(["completed", "completed", "completed"])],
        },
      },
    ];
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    expect(screen.queryByTestId("harness-tasks")).toBeNull();
  });

  it("nests a subagent's own turns under its step", () => {
    subagentState.subagent = {
      id: "44d7b69a-a278-4f0b-a7d5-2158a60b3f07",
      label: "Study skill conventions",
      model: "openai/gpt-5.6-sol",
      status: "finished",
      startedAt: "2026-09-04T10:00:01.000Z",
      endedAt: "2026-09-04T10:00:09.000Z",
      turns: [
        {
          id: "sub:1",
          prompt: { source: "chat", text: "Inspect the repo", attachments: [] },
          trace: {
            startedAt: "2026-09-04T10:00:01.000Z",
            endedAt: "2026-09-04T10:00:09.000Z",
            finalResult: "ok",
            steps: [
              {
                id: "sub:1:c1",
                kind: "search",
                label: "glob",
                status: "ok",
                startedAt: "2026-09-04T10:00:02.000Z",
                endedAt: "2026-09-04T10:00:03.000Z",
                durMs: 1000,
                detail: { terminalOutput: "No files found" },
              },
            ],
          },
          result: { text: "Nothing to report.", streaming: false },
        },
      ],
    };
    state.turns = [
      { id: "t1:user", role: "user", content: "go", timestamp: T0 },
      {
        id: "t1:assistant",
        role: "assistant",
        content: "Delegated.",
        timestamp: T0 + 9000,
        trace: {
          startedAt: T0,
          endedAt: T0 + 9000,
          finalResult: "ok",
          steps: [
            {
              id: "s1",
              kind: "other",
              label: "subagent",
              status: "ok",
              startedAt: T0 + 1000,
              endedAt: T0 + 1100,
              durMs: 100,
              detail: {
                input: {
                  prompt: "Inspect the repo",
                  description: "Study skill conventions",
                  run_in_background: true,
                },
                terminalOutput:
                  "started subagent 44d7b69a-a278-4f0b-a7d5-2158a60b3f07",
                subagentSessionId: "44d7b69a-a278-4f0b-a7d5-2158a60b3f07",
              },
            },
          ],
        },
      },
    ];
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    // Settled turns collapse; open the activity, then the step.
    fireEvent.click(screen.getByTestId("harness-activity-summary"));
    const step = screen.getAllByTestId("harness-step")[0];
    expect(step.textContent).toContain("subagent");
    expect(step.textContent).toContain("Study skill conventions");
    fireEvent.click(step.querySelector("button")!);
    const nested = screen.getByTestId("harness-subagent");
    expect(nested.getAttribute("data-status")).toBe("finished");
    expect(nested.textContent).toContain("Study skill conventions");
    expect(nested.textContent).toContain("openai/gpt-5.6-sol");
    const inner = nested.querySelector(
      '[data-testid="harness-nested-stream"]'
    )!;
    expect(inner.textContent).toContain("Inspect the repo");
    expect(inner.textContent).toContain("Nothing to report.");
    expect(
      inner.querySelector('[data-testid="harness-activity-summary"]')
        ?.textContent
    ).toContain("1 step");
    subagentState.subagent = null;
  });
});

describe("HarnessPane inline shortcuts", () => {
  it("renders the shortcut pins a turn wrote as buttons that fire the pin", () => {
    const withPins = {
      ...agent,
      pins: [
        {
          id: "p1",
          label: "Run the E2E",
          value: "run e2e",
          type: "shortcut",
          group: "Next steps",
        },
        {
          id: "p2",
          label: "Ship it",
          value: "ship",
          type: "shortcut",
          confirm: true,
        },
        { id: "p3", label: "Docs", value: "https://x", type: "url" },
      ],
    } as unknown as Agent;
    state.turns = [
      { id: "t1:user", role: "user", content: "plan", timestamp: T0 },
      {
        id: "t1:assistant",
        role: "assistant",
        content: "Pick one.",
        timestamp: T0 + 1000,
        trace: {
          startedAt: T0,
          endedAt: T0 + 1000,
          finalResult: "ok",
          steps: [
            {
              id: "s1",
              kind: "other",
              label: "mcp__dispatch__dispatch_pins",
              status: "ok",
              startedAt: T0 + 100,
              endedAt: T0 + 200,
              durMs: 100,
              detail: {
                input: {
                  pins: [
                    {
                      label: "Run the E2E",
                      type: "shortcut",
                      value: "run e2e",
                    },
                    { label: "Ship it", type: "shortcut", value: "ship" },
                    { label: "Gone", type: "shortcut", value: "x" },
                    { label: "Docs", type: "url", value: "https://x" },
                  ],
                },
              },
            },
          ],
        },
      },
    ];
    render(
      <HarnessPane agentId="agt_1" agent={withPins} active isMobile={false} />,
      { wrapper }
    );
    const row = screen.getByTestId("harness-shortcuts");
    const items = row.querySelectorAll('[data-testid="pin-item"]');
    expect([...items].map((i) => i.getAttribute("data-pin-label"))).toEqual([
      "Run the E2E",
      "Ship it",
    ]);
    expect(row.textContent).toContain("Next steps");
    fireEvent.click(items[0].querySelector("button")!);
    expect(runShortcut).toHaveBeenCalledWith({
      agentId: "agt_1",
      pinId: "p1",
      label: "Run the E2E",
    });
    // A confirm pin asks first, then sends.
    fireEvent.click(items[1].querySelector("button")!);
    expect(screen.getByTestId("pin-shortcut-confirm-dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pin-shortcut-confirm"));
    expect(runShortcut).toHaveBeenLastCalledWith({
      agentId: "agt_1",
      pinId: "p2",
      label: "Ship it",
    });
  });

  it("opens the usage dialog from the chip", () => {
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    fireEvent.click(screen.getByTestId("harness-usage-chip"));
    expect(screen.getByTestId("harness-usage-dialog")).toBeTruthy();
  });
});

describe("HarnessPane stop and recall", () => {
  it("offers Stop while a turn runs and interrupts on click", () => {
    state.turns = [
      { id: "t1:user", role: "user", content: "go", timestamp: T0 },
    ];
    state.liveTrace = { startedAt: T0, steps: [] };
    state.streaming = true;
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    fireEvent.click(screen.getByTestId("harness-stop"));
    expect(queueInterrupt).toHaveBeenCalledTimes(1);
  });

  it("hides Stop when nothing runs, and ArrowUp pulls the queued message back", async () => {
    state.promptHistory = ["earlier prompt"];
    state.queued = [
      {
        id: "m2",
        source: "chat",
        text: "queued one",
        chatMessageId: "m2",
        attachments: [],
        createdAt: "2026-09-04T10:00:01.000Z",
      },
    ];
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    expect(screen.getByTestId("harness-stop").getAttribute("aria-hidden")).toBe(
      "true"
    );
    const input = screen.getByTestId(
      "chat-composer-input"
    ) as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() => expect(input.value).toBe("queued one"));
    expect(queueRemove).toHaveBeenCalledWith("m2");
  });
});

describe("composerHint", () => {
  it("says what Enter and the arrows do for each state", async () => {
    const { composerHint } = await import("./harness-pane");
    expect(composerHint(false, 0)).toBeUndefined();
    expect(composerHint(true, 0)).toBe(
      "Agent is working · Enter queues your message · Ctrl+C stops"
    );
    expect(composerHint(true, 2)).toBe(
      "Agent is working · Enter queues your message · ↑ edits the queued one · Ctrl+C stops"
    );
    expect(composerHint(false, 1)).toBe(
      "Message queued · ↑ edits the queued one"
    );
  });

  it("refuses to recall a queued message that carries attachments", async () => {
    state.queued = [
      {
        id: "m3",
        source: "chat",
        text: "with a file",
        chatMessageId: "m3",
        attachments: [
          { type: "file", mediaId: 1, fileName: "a.png", sizeBytes: 1 },
        ],
        createdAt: "2026-09-04T10:00:01.000Z",
      },
    ];
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    const input = screen.getByTestId(
      "chat-composer-input"
    ) as HTMLTextAreaElement;
    // The draft atom is per agent and outlives the previous test's render.
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("attachments")
    );
    expect(queueRemove).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("stops the turn on Ctrl+C in the field while one runs", () => {
    state.turns = [
      { id: "t1:user", role: "user", content: "go", timestamp: T0 },
    ];
    state.liveTrace = { startedAt: T0, steps: [] };
    state.streaming = true;
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    const input = screen.getByTestId("chat-composer-input");
    fireEvent.keyDown(input, { key: "c", ctrlKey: true });
    expect(queueInterrupt).toHaveBeenCalledTimes(1);
  });
});

describe("HarnessPane goal strip", () => {
  it("shows an armed goal with its round count, and the reason when blocked", () => {
    state.turns = [
      {
        id: "t1:user",
        role: "user",
        content: "merge when green",
        timestamp: T0,
      },
      {
        id: "t1:assistant",
        role: "assistant",
        content: "Monitoring is armed.",
        timestamp: T0 + 1000,
        trace: {
          startedAt: T0,
          endedAt: T0 + 1000,
          finalResult: "ok",
          steps: [
            {
              id: "g1",
              kind: "other",
              label: "create_goal",
              status: "ok",
              startedAt: T0 + 100,
              endedAt: T0 + 200,
              durMs: 100,
              detail: {
                terminalOutput:
                  '{"goal":{"id":"goal-1","objective":"Merge PR #177 when green","phase":"active","roundsStarted":2,"maxGoalRounds":8},"activation":"armed"}',
              },
            },
          ],
        },
      },
    ];
    render(
      <HarnessPane agentId="agt_1" agent={agent} active isMobile={false} />,
      { wrapper }
    );
    const strip = screen.getByTestId("harness-goal");
    expect(strip.getAttribute("data-phase")).toBe("active");
    expect(strip.textContent).toContain("armed");
    expect(strip.textContent).toContain("round 2 of 8");
    expect(strip.textContent).toContain("Merge PR #177 when green");
    fireEvent.click(screen.getByTestId("harness-goal-toggle"));
    expect(strip.textContent).toContain("runs another round on its own");
  });
});
