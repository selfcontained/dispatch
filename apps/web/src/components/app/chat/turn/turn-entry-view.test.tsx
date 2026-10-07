// @vitest-environment jsdom
import type { ChatTurnEntry, StreamBlockEntry } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FeedContext } from "@/components/app/chat/chat-entries";
import { TurnEntryView } from "@/components/app/chat/turn/turn-entry-view";
import { turnEntry } from "@/test-utils/blocks";

vi.mock("@/components/ui/markdown-mermaid", () => ({
  MermaidBlock: () => null,
}));
vi.mock("@/components/ui/markdown-mermaid-theme", () => ({
  useMermaidTheme: () => "default",
}));

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
});

const AGENT_ID = "agt_1";

const ctx: FeedContext = {
  agentId: AGENT_ID,
  agentName: "builder",
  agentType: "dispatch",
  onOpenFile: () => undefined,
};

const READ_STEP: ChatTurnEntry["trace"]["steps"][number] = {
  id: "stream:13",
  kind: "read",
  label: "Read README.md",
  status: "ok",
  startedAt: "2026-09-08T10:00:01.000Z",
  endedAt: "2026-09-08T10:00:02.000Z",
  durMs: 1000,
  detail: { toolKind: "read", locations: [{ path: "/w/README.md" }] },
};

/**
 * A settled turn's block: the answer as its text, one read step in its
 * trace. `text` is the block's (what the feed shows once the turn lands);
 * `turn` overrides the assembled turn.
 */
function turn(
  overrides: Partial<ChatTurnEntry> = {},
  text = "It documents the CLI."
): StreamBlockEntry {
  return turnEntry({
    id: "turn:12",
    text,
    createdAt: "2026-09-08T10:00:00.000Z",
    turn: {
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
        steps: [READ_STEP],
      },
      ...overrides,
    },
  });
}

function renderTurn(entry: StreamBlockEntry, view: FeedContext = ctx) {
  // The agent post's author mark reads its engine colour through
  // `useIconColor`, which is a React Query read, so the provider is not
  // optional here.
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MotionConfig reducedMotion="always">
          <TurnEntryView
            block={entry.block}
            turn={entry.block.turn!}
            grouped={false}
            ctx={view}
          />
        </MotionConfig>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("TurnEntryView", () => {
  it("renders the answer as the agent's own post, with the step list under it", () => {
    renderTurn(turn());
    // One post: the agent's. The prompt is the user's block, a row of its
    // own in the feed, never drawn by the turn.
    const posts = screen.getAllByTestId("chat-message");
    expect(posts).toHaveLength(1);
    const post = posts[0]!;
    expect(post.getAttribute("data-author")).toBe("agent");
    expect(post.getAttribute("data-origin")).toBe("turn");
    expect(post.getAttribute("data-block-id")).toBe("turn:12");
    expect(post.textContent).not.toContain("read the readme");
    // A post of its own, with the agent's header.
    expect(post.getAttribute("data-grouped")).toBeNull();
    expect(post.className).toContain("mt-3");
    expect(post.textContent).toContain("It documents the CLI.");
    // The activity line is a footnote under the text, inside the agent post.
    const body = post.querySelector('[data-testid="chat-turn-body"]')!;
    const text = body.querySelector('[data-testid="harness-result"]')!;
    const steps = body.querySelector('[data-testid="harness-activity-fold"]')!;
    expect(steps).not.toBeNull();
    expect(
      text.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("shows late ACP text that arrived after the settled block was saved", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderTurn(
      turn(
        {
          settled: true,
          result: {
            text: "The plan.\n\nA clarification after settlement.",
            streaming: false,
          },
        },
        "The plan."
      )
    );
    const result = screen.getByTestId("harness-result");
    expect(result.textContent).toContain("The plan.");
    expect(result.textContent).toContain("A clarification after settlement.");
    fireEvent.click(screen.getByTestId("chat-copy-message"));
    expect(writeText).toHaveBeenCalledWith(
      "The plan.\n\nA clarification after settlement."
    );
  });

  it("eases the agent post's height: the steps and the answer sit in one measured body", () => {
    // A step landing, the thinking row coming and going, the answer
    // streaming in and the steps folding on settle all change the post's
    // height; the body wrapper is what animates between those sizes so the
    // feed above it glides instead of jumping.
    renderTurn(turn());
    const body = screen
      .getByTestId("chat-message")
      .querySelector('[data-testid="chat-turn-body"]');
    expect(body).not.toBeNull();
    expect(
      body!.querySelector('[data-testid="harness-activity-fold"]')
    ).not.toBeNull();
    expect(
      body!.querySelector('[data-testid="harness-result"]')
    ).not.toBeNull();
  });

  it("mutes what the agent said along the way and leaves the final reply bright", () => {
    const text = "Reading the readme.\n\nIt documents the CLI.";
    renderTurn(
      turn(
        {
          settled: true,
          result: { text, streaming: false, lead: "Reading the readme." },
        },
        text
      )
    );
    const lead = screen.getByTestId("harness-result-lead");
    expect(lead.textContent).toBe("Reading the readme.");
    const muted = (el: Element) =>
      el.firstElementChild!.classList.contains("text-muted-foreground");
    expect(muted(lead)).toBe(true);
    const result = screen.getByTestId("harness-result");
    const final = result.lastElementChild!;
    expect(final.textContent).toBe("It documents the CLI.");
    expect(muted(final)).toBe(false);
  });

  it("mutes a lead's table headers and dims its links and code blocks", () => {
    const lead = "See [the docs](https://x.test).\n\n| a |\n| - |\n| 1 |";
    const text = `${lead}\n\nDone.`;
    renderTurn(
      turn({ settled: true, result: { text, streaming: false, lead } }, text)
    );
    const classes = screen.getByTestId("harness-result-lead").firstElementChild!
      .classList;
    expect(classes.contains("prose-th:text-muted-foreground")).toBe(true);
    expect(classes.contains("prose-th:text-foreground")).toBe(false);
    expect(classes.contains("prose-a:text-primary/70")).toBe(true);
    expect(classes.contains("prose-a:text-primary")).toBe(false);
    expect(classes.contains("prose-pre:opacity-70")).toBe(true);
  });

  it("names the block and its settled state on the wrapper", () => {
    renderTurn(turn());
    const wrapper = screen.getByTestId("chat-turn");
    expect(wrapper.getAttribute("data-turn-id")).toBe("turn:12");
    expect(wrapper.getAttribute("data-settled")).toBe("true");
  });

  it("shows a running turn's reply as it is written, quietly, above its activity line", () => {
    // The block's text is empty until the turn settles, so what the reader
    // sees meanwhile is the turn's own text, in the muted in-progress tone.
    renderTurn(
      turn(
        {
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
        },
        ""
      )
    );
    expect(
      screen.getByTestId("chat-turn").getAttribute("data-settled")
    ).toBeNull();
    // Not the settled answer yet, but the words are in the message.
    expect(screen.queryByTestId("harness-result")).toBeNull();
    expect(screen.getByTestId("chat-turn-live-text").textContent).toBe(
      "reading now"
    );
    expect(screen.getByTestId("chat-message").textContent).toContain(
      "reading now"
    );
    // The activity line is still there, and still its own fold.
    expect(screen.getByTestId("harness-activity-fold")).toBeTruthy();
  });

  it("shows a running turn with no words yet as a status line, not a post", () => {
    // Sending a message must not seem to make two: until the reply starts,
    // the turn is who is working and what they are doing, with no header.
    const running = (text?: string) =>
      turn(
        {
          settled: false,
          ...(text ? { result: { text, streaming: true } } : {}),
          trace: {
            startedAt: "2026-09-08T10:00:00.000Z",
            steps: [
              {
                id: "stream:14",
                kind: "execute",
                label: "pnpm test",
                status: "running",
                startedAt: "2026-09-08T10:00:01.000Z",
                detail: { toolKind: "execute" },
              },
            ],
          },
        },
        ""
      );
    renderTurn(running());
    expect(screen.queryByTestId("chat-message")).toBeNull();
    const line = screen.getByTestId("chat-pending-turn");
    expect(line.getAttribute("data-turn-id")).toBe("turn:12");
    expect(screen.getByTestId("chat-pending-turn-author").textContent).toBe(
      "builder"
    );
    expect(
      screen.getByTestId("harness-activity-summary").textContent
    ).toContain("pnpm test");
    cleanup();

    // The reply's first words make it the agent's post.
    renderTurn(running("on it"));
    expect(screen.queryByTestId("chat-pending-turn")).toBeNull();
    expect(screen.getByTestId("chat-message")).toBeTruthy();
  });

  it("hands the reply over to its settled rendering once the turn ends", () => {
    renderTurn(
      turnEntry({
        text: "It documents the CLI.",
        turn: { result: { text: "It documents the CLI.", streaming: false } },
      })
    );
    expect(screen.queryByTestId("chat-turn-live-text")).toBeNull();
    expect(screen.getByTestId("harness-result").textContent).toContain(
      "It documents the CLI."
    );
  });

  it("draws no post for a prompt another agent sent: that post is its own feed row", () => {
    // The message is already a block in the feed, written when it was sent
    // and carrying the sender's relation badge and id. Rendering it here
    // too showed the same words twice, in two cards that disagreed.
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
    const posts = screen.getAllByTestId("chat-message");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.getAttribute("data-author")).toBe("agent");
    expect(posts[0]!.textContent).not.toContain("take a look at the diff");
    expect(screen.queryByTestId("chat-turn-notice")).toBeNull();
    // The turn itself still renders: the steps and the answer.
    expect(screen.getByTestId("harness-result")).not.toBeNull();
  });

  it("renders a plain system prompt as a normal agent turn", () => {
    renderTurn(
      turn({
        prompt: {
          source: "system",
          text: "Rename yourself to match the work you are doing.",
          attachments: [],
        },
      })
    );
    expect(screen.queryByTestId("chat-turn-notice")).toBeNull();
    const posts = screen.getAllByTestId("chat-message");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.getAttribute("data-author")).toBe("agent");
  });

  it("renders a review action as a normal agent turn without a system badge", () => {
    renderTurn(
      turn({
        prompt: {
          source: "system",
          text: "Review requested: architecture-review",
          attachments: [],
        },
      })
    );
    expect(screen.queryByTestId("chat-turn-notice")).toBeNull();
    const posts = screen.getAllByTestId("chat-message");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.getAttribute("data-author")).toBe("agent");
    expect(posts[0]!.textContent).toContain("It documents the CLI.");
  });

  it("does not interpret Dispatch delimiters in a turn prompt", () => {
    renderTurn(
      turn({
        prompt: {
          source: "system",
          text: "--- DISPATCH: REVIEW ITEM RESOLVED ---\nReview ID: 293\n--- END DISPATCH: REVIEW ITEM RESOLVED ---",
          attachments: [],
        },
      })
    );
    expect(screen.queryByTestId("chat-turn-notice")).toBeNull();
    expect(screen.queryByText("Review ID: 293")).toBeNull();
    expect(screen.getByTestId("harness-result").textContent).toContain(
      "It documents the CLI."
    );
  });

  it("says an interrupted turn was cut short", () => {
    renderTurn(
      turn(
        {
          interrupted: true,
          trace: {
            startedAt: "2026-09-08T10:00:00.000Z",
            endedAt: "2026-09-08T10:00:04.000Z",
            finalResult: "interrupted",
            steps: [],
          },
          result: { text: "half", streaming: false },
        },
        "half"
      )
    );
    expect(screen.getByTestId("harness-interrupted").textContent).toContain(
      "Interrupted mid-turn"
    );
    // No steps and a finished trace: no empty step list.
    expect(screen.queryByTestId("harness-activity-fold")).toBeNull();
  });

  it("shows the turn's error under the result", () => {
    renderTurn(
      turn(
        {
          error: "no API key",
          trace: {
            startedAt: "2026-09-08T10:00:00.000Z",
            endedAt: "2026-09-08T10:00:01.000Z",
            finalResult: "error",
            steps: [],
          },
          result: null,
        },
        ""
      )
    );
    expect(screen.getByTestId("harness-result").textContent).toContain(
      "no API key"
    );
  });

  it("folds an unlabeled turn to a verb read off its steps, not to a bare done", () => {
    // The fixture's one step is a read of README.md and the turn carries no
    // label of its own.
    renderTurn(turn());
    const summary = screen.getByTestId("harness-activity-summary");
    expect(summary.textContent).toContain("read README.md");
    expect(summary.getAttribute("aria-label")).toContain("read README.md");
  });

  it("renders another agent's turn as a post under that agent's name", () => {
    const entry = turnEntry({
      id: "turn:child",
      author: { kind: "agent", agentId: "agt_child" },
      text: "All clear.",
      createdAt: "2026-09-08T10:00:00.000Z",
      turn: {
        trace: {
          startedAt: "2026-09-08T10:00:00.000Z",
          endedAt: "2026-09-08T10:00:09.000Z",
          finalResult: "ok",
          steps: [READ_STEP],
        },
      },
    });
    renderTurn(entry, {
      ...ctx,
      peers: {
        agt_child: { name: "reviewer", agentType: "codex", relation: "child" },
      },
    });
    const post = screen.getByTestId("chat-message");
    expect(post.getAttribute("data-author")).toBe("peer");
    expect(screen.getByTestId("chat-post-author").textContent).toBe("reviewer");
    expect(post.textContent).toContain("All clear.");
    expect(screen.getByTestId("chat-turn").getAttribute("data-settled")).toBe(
      "true"
    );
  });

  describe("a failed turn's retry", () => {
    const ERROR = "API Error: 500 Internal server error.";
    const failed = (retry: ChatTurnEntry["retry"]) =>
      turn(
        {
          error: ERROR,
          ...(retry ? { retry } : {}),
          trace: {
            startedAt: "2026-09-08T10:00:00.000Z",
            endedAt: "2026-09-08T10:00:09.000Z",
            finalResult: "error",
            steps: [],
          },
        },
        ERROR
      );

    it("says the error once and offers Retry turn, which runs it again", () => {
      const onRetryTurn = vi.fn();
      renderTurn(failed("open"), { ...ctx, onRetryTurn });
      const result = screen.getByTestId("harness-result");
      // The engine's text and the turn's error are the same words: once.
      expect(result.textContent?.split(ERROR)).toHaveLength(2);
      fireEvent.click(screen.getByTestId("harness-retry-turn"));
      expect(onRetryTurn).toHaveBeenCalledWith("turn:12");
    });

    it("shows the button busy while the retry is in flight", () => {
      renderTurn(failed("open"), {
        ...ctx,
        onRetryTurn: () => undefined,
        retrying: new Set(["turn:12"]),
      });
      const button = screen.getByTestId("harness-retry-turn");
      expect(button).toHaveProperty("disabled", true);
      expect(button.textContent).toContain("Retrying");
    });

    it("folds a retried failure to one quiet line, with no button", () => {
      renderTurn(failed("retried"), { ...ctx, onRetryTurn: () => undefined });
      const line = screen.getByTestId("harness-retried");
      expect(line.textContent).toContain(ERROR);
      expect(line.textContent).toContain("retried");
      expect(screen.getByTestId("harness-result").textContent).toBe(
        line.textContent
      );
      expect(screen.queryByTestId("harness-retry-turn")).toBeNull();
    });

    it("offers nothing on a failure a retry cannot clear", () => {
      renderTurn(failed(undefined), { ...ctx, onRetryTurn: () => undefined });
      expect(screen.queryByTestId("harness-retry-turn")).toBeNull();
      expect(screen.queryByTestId("harness-retried")).toBeNull();
    });
  });
});
