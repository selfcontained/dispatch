// @vitest-environment jsdom
import type { ChatTurnEntry } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FeedContext } from "@/components/app/chat/chat-entries";
import { TurnEntryView } from "@/components/app/chat/turn/turn-entry-view";

vi.mock("@/components/ui/markdown-mermaid", () => ({
  MermaidBlock: () => null,
}));
vi.mock("@/components/ui/markdown-mermaid-theme", () => ({
  useMermaidTheme: () => "default",
}));

afterEach(cleanup);

const AGENT_ID = "agt_1";

const ctx: FeedContext = {
  agentId: AGENT_ID,
  agentName: "builder",
  agentType: "dispatch",
  onOpenMedia: () => undefined,
};

function turn(overrides: Partial<ChatTurnEntry> = {}): ChatTurnEntry {
  return {
    type: "turn",
    id: "turn:12",
    agentId: AGENT_ID,
    at: "2026-09-08T10:00:00.000Z",
    updatedAt: "2026-09-08T10:00:09.000Z",
    prompt: {
      source: "chat",
      text: "read the readme",
      chatMessageId: "11111111-1111-4111-8111-111111111111",
      attachments: [],
    },
    trace: {
      startedAt: "2026-09-08T10:00:00.000Z",
      endedAt: "2026-09-08T10:00:09.000Z",
      finalResult: "ok",
      steps: [
        {
          id: "stream:13",
          kind: "read",
          label: "Read README.md",
          status: "ok",
          startedAt: "2026-09-08T10:00:01.000Z",
          endedAt: "2026-09-08T10:00:02.000Z",
          durMs: 1000,
          detail: { toolKind: "read", locations: [{ path: "/w/README.md" }] },
        },
      ],
    },
    result: { text: "It documents the CLI.", streaming: false },
    settled: true,
    interrupted: false,
    ...overrides,
  };
}

function renderTurn(entry: ChatTurnEntry) {
  // The agent post's author mark reads its engine colour through
  // `useIconColor`, which is a React Query read, so the provider is not
  // optional here.
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MotionConfig reducedMotion="always">
          <TurnEntryView entry={entry} grouped={false} ctx={ctx} />
        </MotionConfig>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("TurnEntryView", () => {
  it("renders the prompt and a compact result post", () => {
    renderTurn(turn());
    const prompt = screen.getByTestId("chat-message");
    expect(prompt.getAttribute("data-author")).toBe("user");
    expect(prompt.textContent).toContain("read the readme");
    const result = screen.getByTestId("chat-turn-result");
    expect(result.getAttribute("data-author-kind")).toBe("agent");
    expect(result.getAttribute("data-grouped")).toBe("true");
    expect(result.parentElement?.className).toContain("mt-3");
    expect(result.textContent).toContain("It documents the CLI.");
    // The rail sits between the two halves, inside the agent post.
    expect(
      screen
        .getByTestId("chat-turn-result")
        .querySelector('[data-testid="harness-activity-fold"]')
    ).not.toBeNull();
  });

  it("eases the agent post's height: the rail and the answer sit in one measured body", () => {
    // A step landing, the thinking row coming and going, the answer
    // streaming in and the rail folding on settle all change the post's
    // height; the body wrapper is what animates between those sizes so the
    // feed above it glides instead of jumping.
    renderTurn(turn());
    const body = screen
      .getByTestId("chat-turn-result")
      .querySelector('[data-testid="chat-turn-body"]');
    expect(body).not.toBeNull();
    expect(
      body!.querySelector('[data-testid="harness-activity-fold"]')
    ).not.toBeNull();
    expect(
      body!.querySelector('[data-testid="harness-result"]')
    ).not.toBeNull();
  });

  it("names the entry and its settled state on the wrapper", () => {
    renderTurn(turn());
    const wrapper = screen.getByTestId("chat-turn");
    expect(wrapper.getAttribute("data-turn-id")).toBe("turn:12");
    expect(wrapper.getAttribute("data-settled")).toBe("true");
  });

  it("shows a running turn's growing text with no settle time under it", () => {
    renderTurn(
      turn({
        settled: false,
        result: { text: "reading now", streaming: true },
        trace: {
          startedAt: "2026-09-08T10:00:00.000Z",
          steps: [
            {
              id: "stream:14",
              kind: "execute",
              label: "bash",
              status: "running",
              startedAt: "2026-09-08T10:00:01.000Z",
              detail: { toolKind: "execute" },
            },
          ],
        },
      })
    );
    expect(
      screen.getByTestId("chat-turn").getAttribute("data-settled")
    ).toBeNull();
    expect(screen.getByTestId("harness-result").textContent).toContain(
      "reading now"
    );
    expect(screen.getByTestId("harness-activity-fold")).toBeTruthy();
  });

  it("leaves a prompt from another agent to its own feed row", () => {
    // The message is already an `agent_message` entry, written when it was
    // sent and carrying the sender's relation badge and id. Rendering it
    // here too showed the same words twice, in two cards that disagreed.
    renderTurn(
      turn({
        prompt: {
          source: "agent",
          text: "take a look at the diff",
          senderName: "Reviewer",
          senderAgentId: "agt_child",
          attachments: [],
        },
      })
    );
    expect(screen.queryByTestId("chat-agent-message")).toBeNull();
    expect(screen.queryByTestId("chat-message")).toBeNull();
    // The turn itself still renders: the rail and the answer.
    expect(screen.getByTestId("chat-turn-result")).not.toBeNull();
  });

  it("renders a prompt Dispatch injected as a notice, not as a user post", () => {
    renderTurn(
      turn({
        prompt: {
          source: "system",
          text: "Rename yourself to match the work you are doing.",
          attachments: [],
        },
      })
    );
    expect(screen.getByTestId("harness-notice")).toBeTruthy();
    expect(screen.queryByTestId("chat-message")).toBeNull();
  });

  it("says an interrupted turn was cut short", () => {
    renderTurn(
      turn({
        interrupted: true,
        trace: {
          startedAt: "2026-09-08T10:00:00.000Z",
          endedAt: "2026-09-08T10:00:04.000Z",
          finalResult: "interrupted",
          steps: [],
        },
        result: { text: "half", streaming: false },
      })
    );
    expect(screen.getByTestId("harness-interrupted").textContent).toContain(
      "Interrupted mid-turn"
    );
    // No steps and a finished trace: no empty rail.
    expect(screen.queryByTestId("harness-activity-fold")).toBeNull();
  });

  it("shows the turn's error under the result", () => {
    renderTurn(
      turn({
        error: "no API key",
        trace: {
          startedAt: "2026-09-08T10:00:00.000Z",
          endedAt: "2026-09-08T10:00:01.000Z",
          finalResult: "error",
          steps: [],
        },
        result: null,
      })
    );
    expect(screen.getByTestId("harness-result").textContent).toContain(
      "no API key"
    );
  });

  it("folds an unlabeled turn to a verb read off its steps, not to a bare done", () => {
    // The fixture's one step is a read of README.md and the turn carries no
    // label, which is every turn whose agent sent no dispatch_event.
    renderTurn(turn());
    const summary = screen.getByTestId("harness-activity-summary");
    expect(summary.textContent).toContain("read README.md");
    expect(summary.getAttribute("aria-label")).toContain("read README.md");
  });

  it("lets the agent's own label win over the step-derived one", () => {
    renderTurn(turn({ label: "Answered the README question" }));
    const summary = screen.getByTestId("harness-activity-summary");
    expect(summary.textContent).toContain("Answered the README question");
    expect(summary.textContent).not.toContain("read README.md");
  });
});
