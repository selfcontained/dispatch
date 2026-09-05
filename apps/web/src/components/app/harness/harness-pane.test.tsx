// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessQuestion } from "@dispatch/shared";

import type { Agent } from "@/components/app/types";

import type { Trace, Turn } from "./contracts";
import { HarnessPane } from "./harness-pane";

const state: {
  turns: Turn[];
  liveTrace: Trace | null;
  liveText: string;
  liveQuestions: HarnessQuestion[];
  streaming: boolean;
  loading: boolean;
  error: Error | null;
} = {
  turns: [],
  liveTrace: null,
  liveText: "",
  liveQuestions: [],
  streaming: false,
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
vi.mock("./use-harness-turns", () => ({
  harnessTurnsQueryKey: (agentId: string | null) => ["harness-turns", agentId],
  useHarnessTurns: () => state,
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
  type: "dsh",
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
  answerMutate.mockClear();
});

const T0 = Date.parse("2026-09-04T10:00:00.000Z");

describe("HarnessPane", () => {
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
