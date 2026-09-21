// @vitest-environment jsdom
import type { ChatTurnEntry, StreamBlockEntry } from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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

afterEach(cleanup);

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
  it("renders the answer as the agent's own post, with the rail under it", () => {
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
    const rail = body.querySelector('[data-testid="harness-activity-fold"]')!;
    expect(rail).not.toBeNull();
    expect(
      text.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("eases the agent post's height: the rail and the answer sit in one measured body", () => {
    // A step landing, the thinking row coming and going, the answer
    // streaming in and the rail folding on settle all change the post's
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

  it("names the block and its settled state on the wrapper", () => {
    renderTurn(turn());
    const wrapper = screen.getByTestId("chat-turn");
    expect(wrapper.getAttribute("data-turn-id")).toBe("turn:12");
    expect(wrapper.getAttribute("data-settled")).toBe("true");
  });

  it("holds a running turn's text back: the post is its header and the activity line until settle", () => {
    // The block's text is empty until the turn settles; whatever the turn
    // has so far stays out of the column too.
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
    expect(screen.queryByTestId("harness-result")).toBeNull();
    // The answer is not in the column: the post is its header and the
    // activity line. What the turn has said so far is inside that line's
    // fold, for a reader who opens it to follow along.
    const fold = screen.getByTestId("harness-activity-fold");
    expect(fold).toBeTruthy();
    expect(screen.getByTestId("harness-live-text").textContent).toBe(
      "reading now"
    );
    const post = screen.getByTestId("chat-message").cloneNode(true) as HTMLElement;
    post.querySelector('[data-testid="harness-activity-fold"]')?.remove();
    expect(post.textContent).not.toContain("reading now");
  });

  it("puts nothing in the activity fold once the turn has settled", () => {
    renderTurn(
      turnEntry({
        text: "It documents the CLI.",
        turn: { result: { text: "It documents the CLI.", streaming: false } },
      })
    );
    expect(screen.queryByTestId("harness-live-text")).toBeNull();
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
    // The turn itself still renders: the rail and the answer.
    expect(screen.getByTestId("harness-result")).not.toBeNull();
  });

  it("renders a prompt Dispatch injected as a notice above the answer, not as a user post", () => {
    renderTurn(
      turn({
        prompt: {
          source: "system",
          text: "Rename yourself to match the work you are doing.",
          attachments: [],
        },
      })
    );
    const notice = screen.getByTestId("chat-turn-notice");
    expect(notice.querySelector('[data-testid="harness-notice"]')).toBeTruthy();
    const posts = screen.getAllByTestId("chat-message");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.getAttribute("data-author")).toBe("agent");
    expect(posts[0]!.contains(notice)).toBe(true);
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
    // No steps and a finished trace: no empty rail.
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
});
