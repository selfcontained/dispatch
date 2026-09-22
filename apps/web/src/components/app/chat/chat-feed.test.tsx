// @vitest-environment jsdom
import type {
  ChatAttachment,
  ChatTurnEntry,
  ChatTurnStep,
  StreamEntry,
} from "@dispatch/shared";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  answered,
  block,
  blockEntry,
  FILE_BODY,
  findingBlock,
  launchBlock,
  questionBody,
  reaction,
  reviewBlock,
  turnEntry,
} from "@/test-utils/blocks";
import type { Agent } from "@/components/app/types";

import {
  type FeedContext,
  POST_BODY_MEASURE,
  peerDirectory,
  POST_TINT,
} from "@/components/app/chat/chat-entries";
import {
  ChatFeed,
  entryGrowthKey,
  entryVersion,
  latestAgentBlockId,
  latestOpenFreeformQuestion,
  latestUserBlockId,
  layoutFeed,
  useEnteringEntries,
} from "@/components/app/chat/chat-feed";

// A launch card reads its agent from the agents list; the list is seeded,
// never fetched.
vi.mock("@/lib/api", () => ({ api: vi.fn(() => new Promise(() => {})) }));

// Mermaid + the copy hook touch browser APIs jsdom lacks; neither is under
// test here.
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

/** An agent's post to another agent: a block with `toAgentId` set. */
function peerPost(fields: {
  id: string;
  from: string;
  to: string;
  text: string;
  at: string;
  delivered?: boolean | null;
}): StreamEntry {
  return blockEntry(
    block({
      id: fields.id,
      author: { kind: "agent", agentId: fields.from },
      toAgentId: fields.to,
      text: fields.text,
      delivered: fields.delivered === undefined ? true : fields.delivered,
      createdAt: fields.at,
    })
  );
}

/** The rendered posts addressed to another agent, whoever wrote them. */
function sidePosts(): HTMLElement[] {
  return screen
    .getAllByTestId("chat-message")
    .filter((el) => el.hasAttribute("data-to-agent"));
}

/** Peers as the feed names them. */
const REVIEWER_PEER = {
  agt_2: { name: "Reviewer", agentType: "codex", relation: "child" as const },
};

function fileAttachment(
  fields: Pick<
    Extract<ChatAttachment, { type: "file" }>,
    "fileId" | "fileName" | "sizeBytes" | "mimeType"
  >
): ChatAttachment {
  return { type: "file", ...fields };
}

function makeCtx(
  overrides: Partial<FeedContext> = {},
  onOpenFile = vi.fn()
): FeedContext {
  return {
    agentId: AGENT_ID,
    agentName: "builder",
    agentType: "claude",
    onOpenFile,
    ...overrides,
  };
}

let queryClient = new QueryClient();

function feedElement(
  entries: StreamEntry[],
  ctx: FeedContext,
  onAnswer: ReturnType<typeof vi.fn>,
  extra: Partial<Parameters<typeof ChatFeed>[0]> = {}
) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ChatFeed
          entries={entries}
          ctx={ctx}
          answeringBlockId={null}
          onAnswer={onAnswer}
          {...extra}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderFeed(
  entries: StreamEntry[],
  extra: Partial<Parameters<typeof ChatFeed>[0]> = {},
  ctxOverrides: Partial<FeedContext> = {},
  /** The agents list, as a launch card reads it. */
  agents: Agent[] = []
) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["agents"], agents);
  const onAnswer = vi.fn();
  const onOpenFile = vi.fn();
  const ctx = makeCtx(ctxOverrides, onOpenFile);
  const view = render(feedElement(entries, ctx, onAnswer, extra));
  const rerenderWith = (next: StreamEntry[]) =>
    view.rerender(feedElement(next, ctx, onAnswer, extra));
  return { onAnswer, onOpenFile, rerenderWith };
}

describe("layoutFeed", () => {
  const now = new Date("2026-09-03T12:00:00.000Z");
  const at = (hhmm: string, day = "02") => `2026-09-${day}T${hhmm}:00.000Z`;

  it("groups same-author posts within five minutes and breaks on author change", () => {
    const rows = layoutFeed(
      [
        blockEntry(block({ id: "a1", createdAt: at("10:00") })),
        blockEntry(block({ id: "a2", createdAt: at("10:03") })),
        blockEntry(
          block({ id: "u1", authorKind: "user", createdAt: at("10:04") })
        ),
        blockEntry(block({ id: "a3", createdAt: at("10:05") })),
      ],
      makeCtx(),
      now
    );
    expect(
      rows.map((r) => (r.kind === "entry" ? [r.entry.id, r.grouped] : r.kind))
    ).toEqual([
      "divider",
      ["a1", false],
      ["a2", true],
      ["u1", false],
      ["a3", false],
    ]);
  });

  it("starts a new group after five minutes", () => {
    const rows = layoutFeed(
      [
        blockEntry(block({ id: "a1", createdAt: at("10:00") })),
        blockEntry(block({ id: "a2", createdAt: at("10:06") })),
        blockEntry(block({ id: "a3", createdAt: at("10:07") })),
      ],
      makeCtx(),
      now
    );
    expect(
      rows.map((r) => (r.kind === "entry" ? [r.entry.id, r.grouped] : r.kind))
    ).toEqual(["divider", ["a1", false], ["a2", false], ["a3", true]]);
  });

  it("draws a rule only where a new author group follows another post directly", () => {
    const rows = layoutFeed(
      [
        blockEntry(block({ id: "a1", createdAt: at("10:00") })),
        blockEntry(block({ id: "a2", createdAt: at("10:01") })),
        blockEntry(
          block({ id: "u1", authorKind: "user", createdAt: at("10:02") })
        ),
        blockEntry(block({ id: "a3", createdAt: at("10:03") })),
        blockEntry(block({ id: "a4", createdAt: at("10:00", "03") })),
        blockEntry(
          block({
            id: "u2",
            authorKind: "user",
            createdAt: at("10:01", "03"),
          })
        ),
      ],
      makeCtx(),
      now
    );
    expect(
      rows
        .filter((r) => r.kind === "entry")
        .map((r) => (r.kind === "entry" ? [r.entry.id, r.rule] : null))
    ).toEqual([
      // First post of the day: the day rule already separates it.
      ["a1", false],
      // Grouped under a1: no boundary at all.
      ["a2", false],
      // Author change straight after a post: hairline, each way.
      ["u1", true],
      ["a3", true],
      // Day rule again.
      ["a4", false],
      ["u2", true],
    ]);
  });

  it("groups a file block with the agent's posts but keeps a side conversation apart", () => {
    const rows = layoutFeed(
      [
        blockEntry(block({ id: "a1", createdAt: at("10:00") })),
        blockEntry(
          block({
            id: "md1",
            text: "",
            body: FILE_BODY,
            attachments: [
              fileAttachment({ fileId: 1, fileName: "x.png", sizeBytes: 1 }),
            ],
            createdAt: at("10:01"),
          })
        ),
        peerPost({
          id: "am1",
          from: AGENT_ID,
          to: "agt_2",
          text: "ping",
          at: at("10:02"),
        }),
        peerPost({
          id: "am2",
          from: "agt_2",
          to: AGENT_ID,
          text: "pong",
          at: at("10:03"),
        }),
      ],
      makeCtx(),
      now
    );
    expect(
      rows.map((r) => (r.kind === "entry" ? [r.entry.id, r.grouped] : r.kind))
    ).toEqual([
      "divider",
      ["a1", false],
      ["md1", true],
      // An agent-to-agent message is a side conversation: never grouped
      // under the agent's post to the user, and the reply starts a group
      // of its own.
      ["am1", false],
      ["am2", false],
    ]);
  });

  it("puts a labelled rule between days", () => {
    const rows = layoutFeed(
      [
        blockEntry(block({ id: "a1", createdAt: at("10:00", "01") })),
        blockEntry(block({ id: "a2", createdAt: at("10:00", "02") })),
        blockEntry(block({ id: "a3", createdAt: at("10:00", "03") })),
      ],
      makeCtx(),
      now
    );
    const dividers = rows.filter((r) => r.kind === "divider");
    expect(dividers).toHaveLength(3);
    expect(dividers.map((d) => d.kind === "divider" && d.label)).toEqual([
      expect.stringMatching(/September 1/),
      "Yesterday",
      "Today",
    ]);
    expect(rows[3]).toMatchObject({ kind: "entry", grouped: false });
  });
});

describe("latest message helpers", () => {
  it("finds the newest user and agent message ids", () => {
    const entries = [
      blockEntry(block({ id: "a1" })),
      blockEntry(block({ id: "u1", authorKind: "user" })),
      blockEntry(block({ id: "a2" })),
    ];
    expect(latestUserBlockId(entries)).toBe("u1");
    expect(latestAgentBlockId(entries)).toBe("a2");
    expect(latestUserBlockId([])).toBeNull();
  });
});

describe("latestOpenFreeformQuestion", () => {
  const freeform = (id: string, isAnswered = false) =>
    blockEntry(
      block({
        id,
        text: `Q ${id}`,
        body: questionBody([{ label: "A" }], {
          allowFreeform: true,
          state: isAnswered ? answered("A") : {},
        }),
      })
    );
  const fixed = (id: string) =>
    blockEntry(
      block({
        id,
        text: `Q ${id}`,
        body: questionBody([{ label: "A" }]),
      })
    );

  it("returns the newest unanswered question that allows a typed reply", () => {
    expect(
      latestOpenFreeformQuestion([freeform("q1"), freeform("q2")])?.id
    ).toBe("q2");
  });

  it("falls back to an older open question once the newest is answered", () => {
    expect(
      latestOpenFreeformQuestion([freeform("q1"), freeform("q2", true)])?.id
    ).toBe("q1");
  });

  it("returns nothing when the newest open question is option-only", () => {
    expect(
      latestOpenFreeformQuestion([freeform("q1"), fixed("q2")])
    ).toBeNull();
    expect(
      latestOpenFreeformQuestion([blockEntry(block({ id: "a1" }))])
    ).toBeNull();
  });

  it("looks past later replies to the open question", () => {
    expect(
      latestOpenFreeformQuestion([
        freeform("q1"),
        blockEntry(block({ id: "a2" })),
      ])?.id
    ).toBe("q1");
  });
});

describe("ChatFeed", () => {
  it("copies the raw text of chat and agent-to-agent messages", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderFeed([
      blockEntry(
        block({
          id: "u1",
          authorKind: "user",
          text: "User message",
          delivered: true,
        })
      ),
      blockEntry(block({ id: "a1", text: "Hello **there**" })),
      peerPost({
        id: "p1",
        from: "agt_2",
        to: AGENT_ID,
        text: "Peer message",
        at: "2026-09-02T10:01:00.000Z",
      }),
    ]);

    const copyButtons = screen.getAllByTestId("chat-copy-message");
    expect(copyButtons).toHaveLength(3);
    fireEvent.click(copyButtons[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("User message"));

    fireEvent.click(copyButtons[1]!);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Hello **there**")
    );
    expect(screen.getAllByLabelText("Message copied")).toHaveLength(2);

    fireEvent.click(copyButtons[2]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Peer message"));
  });

  it("does not show a copy action for an attachment-only post", () => {
    renderFeed([
      blockEntry(
        block({
          id: "a1",
          text: "",
          attachments: [
            { type: "link", url: "https://example.com", title: "Example" },
          ],
        })
      ),
    ]);
    expect(screen.queryByTestId("chat-copy-message")).toBeNull();
  });

  it('renders a user post under a "You" header with delivery failure marker', () => {
    renderFeed([
      blockEntry(
        block({
          id: "u1",
          authorKind: "user",
          text: "Ship it",
          delivered: false,
        })
      ),
    ]);
    const post = screen.getByTestId("chat-message");
    expect(post.getAttribute("data-author")).toBe("user");
    expect(post.textContent).toContain("Ship it");
    expect(screen.getByTestId("chat-post-author").textContent).toBe("You");
    expect(screen.getByTestId("chat-avatar-user")).toBeTruthy();
    expect(screen.getByTestId("chat-delivery-failed")).toBeTruthy();
  });

  it("offers Send again on a post the agent never took, and says so while it goes", () => {
    const onRetryDelivery = vi.fn();
    const failed = blockEntry(
      block({ id: "u1", authorKind: "user", text: "Ship it", delivered: false })
    );
    renderFeed([failed], {}, { onRetryDelivery });
    fireEvent.click(screen.getByTestId("chat-delivery-retry"));
    expect(onRetryDelivery).toHaveBeenCalledWith("u1");

    cleanup();
    renderFeed([failed], {}, { onRetryDelivery, retrying: new Set(["u1"]) });
    const button = screen.getByTestId(
      "chat-delivery-retry"
    ) as HTMLButtonElement;
    expect(button.textContent).toBe("Sending…");
    expect(button.disabled).toBe(true);
  });

  it("names who a post to several agents is still waiting on", () => {
    const peers = {
      agt_2: {
        name: "reviewer",
        agentType: "claude",
        relation: "child" as const,
      },
      agt_3: { name: "scout", agentType: "claude", relation: "child" as const },
    };
    renderFeed(
      [
        blockEntry(
          block({
            id: "u1",
            authorKind: "user",
            text: "@reviewer @scout have a look",
            delivery: [
              { agentId: "agt_2", state: "delivered" },
              { agentId: "agt_3", state: "held" },
            ],
          })
        ),
      ],
      {},
      { peers }
    );
    expect(screen.getByTestId("chat-held-hint").textContent).toContain(
      "Queued for scout, until the turn ends"
    );
  });

  it("names only the agent that missed a post, and offers one Retry", () => {
    const peers = {
      agt_2: {
        name: "reviewer",
        agentType: "claude",
        relation: "child" as const,
      },
      agt_3: { name: "scout", agentType: "claude", relation: "child" as const },
    };
    const onRetryDelivery = vi.fn();
    renderFeed(
      [
        blockEntry(
          block({
            id: "u1",
            authorKind: "user",
            text: "@reviewer @scout have a look",
            delivered: false,
            delivery: [
              { agentId: "agt_2", state: "delivered" },
              { agentId: "agt_3", state: "failed" },
            ],
          })
        ),
      ],
      {},
      { peers, onRetryDelivery }
    );
    expect(screen.getByTestId("chat-delivery-failed").textContent).toContain(
      "Not delivered to scout"
    );
    fireEvent.click(screen.getByTestId("chat-delivery-retry"));
    expect(onRetryDelivery).toHaveBeenCalledWith("u1");
  });

  it("says nothing once every recipient has the post", () => {
    renderFeed([
      blockEntry(
        block({
          id: "u1",
          authorKind: "user",
          text: "done",
          delivered: true,
        })
      ),
    ]);
    expect(screen.queryByTestId("chat-delivery-failed")).toBeNull();
    expect(screen.queryByTestId("chat-held-hint")).toBeNull();
    expect(screen.queryByTestId("chat-delivery-pending")).toBeNull();
  });

  const steps = {
    worktree: (
      status: "done" | "failed" = "done",
      endedAt = "2026-09-02T10:00:04.000Z"
    ) => ({
      phase: "worktree",
      label: "Creating git worktree",
      startedAt: "2026-09-02T10:00:00.000Z",
      endedAt,
      status,
    }),
  };

  it("lists the startup steps on the agent's card while its workspace comes up", () => {
    renderFeed(
      [
        blockEntry(
          launchBlock({
            id: "l1",
            toAgentId: AGENT_ID,
            launchState: {
              startup: {
                steps: [
                  steps.worktree(),
                  {
                    phase: "deps",
                    label: "Installing dependencies",
                    startedAt: "2026-09-02T10:00:04.000Z",
                    status: "running",
                  },
                ],
              },
            },
          })
        ),
      ],
      {},
      { onToggleReaction: vi.fn() }
    );
    const post = screen.getByTestId("chat-launch-card");
    expect(post.getAttribute("data-launch-card")).toBe("true");
    expect(post.getAttribute("data-kind")).toBe("launch");
    // The card stands for the agent it launched, this page's agent, under
    // a launch mark: a record of it starting, not a post it wrote.
    expect(screen.getByTestId("chat-post-author").textContent).toBe(
      "Started builder"
    );
    expect(screen.getByTestId("chat-avatar-launch")).toBeTruthy();
    expect(post.getAttribute("data-author-kind")).toBe("agent");
    expect(screen.getByTestId("chat-launch-meta").textContent).toContain(
      "Launched by you"
    );
    // The step list stands open while it runs, with no fold over it: each
    // step can be watched as it runs.
    const startup = screen.getByTestId("chat-launch-startup");
    expect(screen.queryByTestId("chat-launch-startup-toggle")).toBeNull();
    expect(screen.queryByTestId("harness-activity-summary")).toBeNull();
    const rows = within(startup).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("creating git worktree");
    expect(rows[0]!.textContent).toContain("4.0s");
    expect(
      rows[1]!.querySelector("[aria-label]")?.getAttribute("aria-label")
    ).toBe("installing dependencies, running");
    // A launch card is a record Dispatch keeps: nothing to react to, even
    // where the feed offers reactions.
    expect(screen.queryByTestId("chat-add-reaction")).toBeNull();
    expect(screen.queryByTestId("chat-add-reaction-disabled")).toBeNull();
  });

  it("offers reactions on the agent's posts but not on its card", () => {
    renderFeed(
      [
        blockEntry(launchBlock({ id: "l1", toAgentId: AGENT_ID, text: "Go" })),
        blockEntry(
          block({
            id: "a1",
            text: "On it.",
            createdAt: "2026-09-02T10:10:00.000Z",
          })
        ),
      ],
      {},
      { onToggleReaction: vi.fn() }
    );
    const card = screen.getByTestId("chat-launch-card");
    const reply = screen.getByTestId("chat-message");
    expect(card!.querySelector('[data-testid="chat-add-reaction"]')).toBeNull();
    expect(
      reply!.querySelector('[data-testid="chat-add-reaction"]')
    ).not.toBeNull();
  });

  it("folds the startup to how long it took once the agent is up", () => {
    renderFeed([
      blockEntry(
        launchBlock({
          id: "l1",
          toAgentId: AGENT_ID,
          launchState: {
            startup: {
              steps: [
                steps.worktree("done", "2026-09-02T10:00:02.000Z"),
                {
                  phase: "deps",
                  label: "Installing dependencies",
                  startedAt: "2026-09-02T10:00:02.000Z",
                  endedAt: "2026-09-02T10:00:09.000Z",
                  status: "done",
                },
              ],
              readyAt: "2026-09-02T10:00:09.000Z",
              cwd: "/Users/brad/dev/thing/.dispatch/worktrees/a-long-branch-name-that-goes-on",
            },
          },
        })
      ),
    ]);
    const section = screen.getByTestId("chat-launch-startup");
    const toggle = screen.getByTestId("chat-launch-startup-toggle");
    expect(toggle.textContent).toContain("Started");
    expect(toggle.textContent).toContain("in 9.0s");
    expect(section.getAttribute("data-open")).toBe("false");
    fireEvent.click(toggle);
    expect(section.getAttribute("data-open")).toBe("true");
    // The whole path, never cut to a count of characters; when the row is
    // too narrow it gives up its start, so the directory's name stays.
    const aside = within(section).getByTestId("harness-step-aside");
    expect(aside.textContent).toContain(
      "/Users/brad/dev/thing/.dispatch/worktrees/a-long-branch-name-that-goes-on"
    );
    expect(aside.querySelector('[dir="rtl"] > bdi[dir="ltr"]')).not.toBeNull();
  });

  it("says which step failed when the workspace never came up, standing open", () => {
    renderFeed([
      blockEntry(
        launchBlock({
          id: "l1",
          toAgentId: AGENT_ID,
          launchState: {
            startup: {
              steps: [
                {
                  ...steps.worktree("failed", "2026-09-02T10:00:02.000Z"),
                  detail: "branch already checked out",
                },
              ],
              failed: "branch already checked out",
            },
          },
        })
      ),
    ]);
    const section = screen.getByTestId("chat-launch-startup");
    expect(section.getAttribute("data-open")).toBe("true");
    expect(
      screen.getByTestId("chat-launch-startup-toggle").textContent
    ).toContain("Startup failed");
    // The step list reads a failed step the way it reads one in a turn.
    const row = within(section).getAllByRole("listitem")[0]!;
    expect(row.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(
      "creating git worktree, failed"
    );
    expect(row.textContent).toContain("branch already checked out");
    // A reason is read from its start: it clips at the end, as text does.
    expect(row.querySelector('[dir="rtl"]')).toBeNull();
  });

  it("folds the instructions the agent was started with to a line count", () => {
    renderFeed([
      blockEntry(
        launchBlock({
          id: "l1",
          toAgentId: AGENT_ID,
          launchState: {
            instructions: "You are builder.\nBe brief.\nShip it.",
          },
        })
      ),
    ]);
    const section = screen.getByTestId("chat-launch-instructions");
    const toggle = screen.getByTestId("chat-launch-instructions-toggle");
    expect(toggle.textContent).toContain("Instructions");
    expect(toggle.textContent).toContain("3 lines");
    expect(section.getAttribute("data-open")).toBe("false");
    fireEvent.click(toggle);
    expect(section.getAttribute("data-open")).toBe("true");
    expect(section.querySelector("pre")?.textContent).toBe(
      "You are builder.\nBe brief.\nShip it."
    );
  });

  it("draws a shown block whole on its card: its own words and attachments too", () => {
    const review = reviewBlock({
      id: "rv1",
      author: { kind: "agent", agentId: "agt_2" },
      toAgentId: AGENT_ID,
      threadId: "l1",
      replyTo: "l1",
      text: "Checked both edits; screenshot attached.",
      attachments: [
        { type: "link", url: "https://example.com/run", title: "The run" },
      ],
      summary: "Fine.",
    });
    renderFeed(
      [
        blockEntry(
          launchBlock({
            id: "l1",
            toAgentId: "agt_2",
            launchedByAgentId: AGENT_ID,
            blocks: [review],
          })
        ),
      ],
      {},
      { peers: REVIEWER_PEER }
    );
    const shown = screen.getByTestId("chat-shown-block");
    expect(shown.textContent).toContain(
      "Checked both edits; screenshot attached."
    );
    expect(within(shown).getByTestId("chat-attachment-link")).toBeTruthy();
    expect(within(shown).getByTestId("chat-review-block")).toBeTruthy();
  });

  it("shows the review a launched reviewer posted on its card, compactly, opening the card's thread", () => {
    const onOpenThread = vi.fn();
    const finding = findingBlock(
      "f1",
      { severity: "major", title: "Null deref", body: "Guard it." },
      { author: { kind: "agent", agentId: "agt_2" } }
    );
    const review = reviewBlock({
      id: "rv1",
      author: { kind: "agent", agentId: "agt_2" },
      toAgentId: AGENT_ID,
      threadId: "l1",
      replyTo: "l1",
      summary: "One thing to fix. Otherwise fine.",
      findings: [finding],
    });
    renderFeed(
      [
        blockEntry(
          launchBlock({
            id: "l1",
            toAgentId: "agt_2",
            launchedByAgentId: AGENT_ID,
            text: "Review the change.",
            blocks: [review],
          })
        ),
      ],
      {},
      { peers: REVIEWER_PEER, onOpenThread }
    );
    // One post, the reviewer's card, with the review inside it.
    expect(screen.getAllByTestId("chat-launch-card")).toHaveLength(1);
    expect(screen.queryAllByTestId("chat-message")).toHaveLength(0);
    expect(screen.getByTestId("chat-post-author").textContent).toBe(
      "Started Reviewer"
    );
    const shown = screen.getAllByTestId("chat-shown-block");
    expect(
      shown.map((el) => [
        el.getAttribute("data-block-id"),
        el.getAttribute("data-kind"),
      ])
    ).toEqual([["rv1", "review"]]);
    const card = within(shown[0]!).getByTestId("chat-review-block");
    expect(card.getAttribute("data-compact")).toBe("true");
    expect(within(card).getByTestId("chat-review-status").textContent).toBe(
      "Changes requested"
    );
    expect(
      within(card).getByTestId("chat-review-summary-line").textContent
    ).toBe("One thing to fix.");
    // Compact in the stream: the findings wait for the drawer.
    expect(screen.queryByTestId("chat-review-finding")).toBeNull();
    fireEvent.click(within(card).getByTestId("chat-review-header"));
    expect(onOpenThread).toHaveBeenCalledWith("l1");
  });

  it("names an archived agent's posts, and posts to it, from the page's names", () => {
    // The archived child is gone from the directory; only the page names it.
    renderFeed(
      [
        blockEntry(
          block({
            id: "c1",
            author: { kind: "agent", agentId: "agt_gone" },
            text: "Done; archiving myself.",
            createdAt: "2026-09-02T10:00:00.000Z",
          })
        ),
        peerPost({
          id: "p1",
          from: AGENT_ID,
          to: "agt_gone",
          text: "Thanks.",
          at: "2026-09-02T10:30:00.000Z",
        }),
      ],
      {},
      { peers: REVIEWER_PEER, names: { agt_gone: "helper" } }
    );
    const [childPost, sidePost] = screen.getAllByTestId("chat-message");
    expect(childPost!.textContent).toContain("helper");
    expect(childPost!.textContent).not.toMatch(/^Agent/);
    expect(sidePost!.textContent).toContain("helper");
  });

  it("prefers the live directory's name to the page's", () => {
    renderFeed(
      [
        blockEntry(
          block({
            id: "c1",
            author: { kind: "agent", agentId: "agt_2" },
            text: "hi",
          })
        ),
      ],
      {},
      { peers: REVIEWER_PEER, names: { agt_2: "old name" } }
    );
    const post = screen.getByTestId("chat-message");
    expect(post.textContent).toContain("Reviewer");
    expect(post.textContent).not.toContain("old name");
  });

  it("folds the briefing one agent wrote for another, on the launched agent's card", () => {
    const peers = {
      agt_2: {
        name: "architecture review",
        agentType: "claude",
        relation: "child" as const,
      },
    };
    renderFeed(
      [
        blockEntry(
          launchBlock({
            id: "l1",
            toAgentId: "agt_2",
            launchedByAgentId: AGENT_ID,
            text: "Review the UNCOMMITTED changes in this worktree.\n\n## What changed and why\nA long briefing.",
          })
        ),
      ],
      {},
      { peers },
      [
        {
          id: "agt_2",
          name: "architecture review",
          type: "claude",
          status: "running",
          persona: "architecture-review",
          parentAgentId: AGENT_ID,
        } as Agent,
      ]
    );
    // The card is a post by the agent it launched, not by its launcher.
    const post = screen.getByTestId("chat-launch-card");
    expect(post.getAttribute("data-launch-card")).toBe("true");
    expect(post.getAttribute("data-author")).toBe("peer");
    expect(screen.getByTestId("chat-post-author").textContent).toBe(
      "Started architecture review"
    );
    expect(screen.getByTestId("chat-launch-meta").textContent).toContain(
      "Launched by builder"
    );
    // Who the agent is comes from its record.
    expect(screen.getByTestId("chat-launch-persona").textContent).toBe(
      "architecture-review"
    );
    const row = screen.getByTestId("chat-launch-briefing");
    const header = screen.getByTestId("chat-launch-briefing-toggle");
    expect(header.textContent).toContain("Briefing");
    expect(header.textContent).toContain(
      "Review the UNCOMMITTED changes in this worktree."
    );
    expect(header.textContent).not.toContain("What changed and why");
    expect(row.getAttribute("data-open")).toBe("false");
    fireEvent.click(header);
    expect(row.getAttribute("data-open")).toBe("true");
    expect(
      screen.getByTestId("chat-launch-briefing-body").textContent
    ).toContain("What changed and why");
    // Not a side conversation: the card has no "→ recipient".
    expect(screen.queryByTestId("chat-side-header")).toBeNull();
  });

  it("opens the briefing a person wrote to start this agent, on the agent's card", () => {
    const launch = launchBlock({
      id: "l0",
      toAgentId: AGENT_ID,
      text: "Build the widget",
      attachments: [
        { type: "link", url: "https://example.com/spec" },
        fileAttachment({ fileId: 7, fileName: "brief.md", sizeBytes: 300 }),
      ],
      createdAt: "2026-09-02T10:00:00.000Z",
    });
    const followUp = block({
      id: "follow",
      authorKind: "user",
      text: "Also add tests",
      delivered: true,
      createdAt: "2026-09-02T10:01:00.000Z",
    });
    renderFeed([blockEntry(launch), blockEntry(followUp)]);
    const posts = [
      screen.getByTestId("chat-launch-card"),
      ...screen.getAllByTestId("chat-message"),
    ];
    expect(posts[0]!.getAttribute("data-launch-card")).toBe("true");
    expect(posts[0]!.getAttribute("data-author-kind")).toBe("agent");
    expect(
      screen.getAllByTestId("chat-post-author").map((a) => a.textContent)
    ).toEqual(["Started builder", "You"]);
    expect(screen.getByTestId("chat-launch-meta").textContent).toContain(
      "Launched by you"
    );
    // A person's own words stand open.
    expect(
      screen.getByTestId("chat-launch-briefing").getAttribute("data-open")
    ).toBe("true");
    expect(
      screen.getByTestId("chat-launch-briefing-body").textContent
    ).toContain("Build the widget");
    expect(screen.getByTestId("chat-attachment-link")).toBeTruthy();
    expect(screen.getByTestId("chat-attachment-file")).toBeTruthy();
    // No delivery marker: the prompt went out with the launch.
    expect(screen.queryByTestId("chat-delivery-pending")).toBeNull();
    expect(screen.queryByTestId("chat-delivery-failed")).toBeNull();
    // The card is the agent's, so the person's next post starts a group.
    expect(posts.map((p) => p.getAttribute("data-grouped"))).toEqual([
      null,
      null,
    ]);
  });

  it("offers no Retry when the feed has no way to send again", () => {
    renderFeed([
      blockEntry(
        block({
          id: "u1",
          authorKind: "user",
          text: "Ship it",
          delivered: false,
        })
      ),
    ]);
    expect(screen.queryByTestId("chat-delivery-retry")).toBeNull();
  });

  it("collapses consecutive posts by one author under a single header", () => {
    renderFeed([
      blockEntry(block({ id: "a1", text: "first" })),
      blockEntry(
        block({
          id: "a2",
          text: "second",
          createdAt: "2026-09-02T10:02:00.000Z",
        })
      ),
      blockEntry(
        block({
          id: "u1",
          authorKind: "user",
          text: "reply",
          createdAt: "2026-09-02T10:03:00.000Z",
        })
      ),
    ]);
    const posts = screen.getAllByTestId("chat-message");
    expect(posts.map((p) => p.getAttribute("data-grouped"))).toEqual([
      null,
      "true",
      null,
    ]);
    const authors = screen.getAllByTestId("chat-post-author");
    expect(authors.map((a) => a.textContent)).toEqual(["builder", "You"]);
    expect(screen.getAllByTestId("chat-gutter-time")).toHaveLength(1);
    expect(screen.getByTestId("chat-day-divider")).toBeTruthy();
  });

  it("shows a peer's own icon, its engine and model, and how it stands to this agent", () => {
    const peers = peerDirectory(AGENT_ID, [
      {
        id: AGENT_ID,
        name: "builder",
        type: "claude",
        parentAgentId: "agt_root",
      },
      {
        id: "agt_kid",
        name: "kid",
        type: "codex",
        model: "gpt-5-codex",
        parentAgentId: AGENT_ID,
      },
      { id: "agt_root", name: "root", type: "claude", parentAgentId: null },
      {
        id: "agt_sib",
        name: "sib",
        type: "codex",
        parentAgentId: "agt_root",
      },
      { id: "agt_far", name: "far", type: "claude", parentAgentId: null },
    ]);
    expect(peers[AGENT_ID]).toBeUndefined();
    const from = (id: string, senderAgentId: string, minute: string) =>
      peerPost({
        id,
        from: senderAgentId,
        to: AGENT_ID,
        text: `from ${senderAgentId}`,
        at: `2026-09-02T10:${minute}:00.000Z`,
      });
    renderFeed(
      [
        from("p1", "agt_kid", "00"),
        from("p2", "agt_root", "10"),
        from("p3", "agt_sib", "20"),
        from("p4", "agt_far", "30"),
        from("p5", "agt_gone", "40"),
      ],
      {},
      {
        peers,
        // The catalog names the model; the chip shows the name, keeps the id.
        modelLabel: (type, model) =>
          type === "codex" && model === "gpt-5-codex" ? "GPT-5 Codex" : model,
      }
    );
    const posts = sidePosts();
    // Under the name: the engine, the model when known, and the relation
    // when there is one to state.
    expect(
      posts.map(
        (post) =>
          post.querySelector('[data-testid="agent-relation-badge"]')
            ?.textContent ?? null
      )
    ).toEqual(["child agent", "parent", "sibling", null, null]);
    expect(
      posts.map(
        (post) =>
          post.querySelector('[data-testid="chat-author-engine"]')
            ?.textContent ?? null
      )
    ).toEqual(["Codex", "Claude", "Codex", "Claude", null]);
    const modelChip = posts[0]!.querySelector(
      '[data-testid="chat-author-model"]'
    );
    expect(modelChip?.textContent).toBe("GPT-5 Codex");
    expect(modelChip?.getAttribute("title")).toBe("gpt-5-codex");
    expect(
      posts[1]!.querySelector('[data-testid="chat-author-model"]')
    ).toBeNull();
    // Each agent in the tree wears its seat number (the root is 1, then
    // creation order); an agent outside the tree or gone from the list
    // wears a plain face.
    expect(
      posts.map((post) =>
        post
          .querySelector('[data-testid="chat-avatar-agent"]')
          ?.getAttribute("aria-label")
      )
    ).toEqual([
      "kid, agent 4",
      "root, agent 1",
      "sib, agent 3",
      "far, agent",
      "Agent, agent",
    ]);
    // Still a peer post: muted side-conversation treatment, the sender's
    // name as the agents list knows it.
    expect(posts[0]!.className).toContain(POST_TINT.peer);
    expect(
      posts[0]!.querySelector('[data-testid="chat-post-author"]')?.textContent
    ).toBe("kid");
  });

  it("falls back to a plain agent for a peer before the agent list has loaded", () => {
    renderFeed([
      peerPost({
        id: "p1",
        from: "agt_2",
        to: AGENT_ID,
        text: "hi",
        at: "2026-09-02T10:00:00.000Z",
      }),
    ]);
    const post = sidePosts()[0]!;
    expect(
      post
        .querySelector('[data-testid="chat-avatar-agent"]')
        ?.getAttribute("aria-label")
    ).toBe("Agent, agent");
    // This agent's own outgoing posts carry no badge.
  });

  it("gives the agent's own outgoing message its icon and no relation badge", () => {
    renderFeed(
      [
        peerPost({
          id: "o1",
          from: AGENT_ID,
          to: "agt_2",
          text: "ping",
          at: "2026-09-02T10:00:00.000Z",
        }),
      ],
      {},
      { peers: REVIEWER_PEER }
    );
    const post = sidePosts()[0]!;
    expect(
      post.querySelector('[data-testid="agent-relation-badge"]')
    ).toBeNull();
    expect(
      post.querySelector('[data-testid="chat-avatar-agent"]')
    ).not.toBeNull();
    expect(
      post
        .querySelector("[data-testid='chat-side-header']")
        ?.getAttribute("aria-label")
    ).toBe("builder → Reviewer");
  });

  it("names who launched an agent on its card, falling back to Agent", () => {
    const peers = peerDirectory(AGENT_ID, [
      {
        id: AGENT_ID,
        name: "builder",
        type: "claude",
        parentAgentId: "agt_root",
      },
      {
        id: "agt_root",
        name: "orchestrator",
        type: "codex",
        parentAgentId: null,
      },
    ]);
    const launch = launchBlock({
      id: "launch",
      toAgentId: AGENT_ID,
      launchedByAgentId: "agt_root",
      text: "Build the widget",
      createdAt: "2026-09-02T10:00:00.000Z",
    });
    renderFeed([blockEntry(launch)], {}, { peers });
    const post = screen.getByTestId("chat-launch-card");
    // The card is the launched agent's: this page's.
    expect(post.getAttribute("data-author-kind")).toBe("agent");
    expect(screen.getByTestId("chat-post-author").textContent).toBe(
      "Started builder"
    );
    expect(screen.getByTestId("chat-launch-meta").textContent).toContain(
      "Launched by orchestrator"
    );
    expect(screen.queryByTestId("chat-avatar-user")).toBeNull();
    // An agent's briefing folds.
    expect(
      screen.getByTestId("chat-launch-briefing").getAttribute("data-open")
    ).toBe("false");
    cleanup();

    // The launcher is gone from the list: a generic name.
    renderFeed([blockEntry(launch)], {}, { peers: {} });
    expect(screen.getByTestId("chat-launch-meta").textContent).toContain(
      "Launched by Agent"
    );
  });
  it("tints You and peer posts, leaves the agent's plain, and marks group boundaries", () => {
    renderFeed([
      blockEntry(block({ id: "a1", text: "agent one" })),
      blockEntry(
        block({
          id: "u1",
          authorKind: "user",
          text: "user one",
          createdAt: "2026-09-02T10:01:00.000Z",
        })
      ),
      blockEntry(
        block({
          id: "u2",
          authorKind: "user",
          text: "user two",
          createdAt: "2026-09-02T10:02:00.000Z",
        })
      ),
      peerPost({
        id: "am1",
        from: "agt_2",
        to: AGENT_ID,
        text: "peer",
        at: "2026-09-02T10:03:00.000Z",
      }),
    ]);
    const [agentPost, userOne, userTwo] = screen.getAllByTestId("chat-message");
    const peer = sidePosts()[0]!;

    expect(agentPost!.getAttribute("data-author-kind")).toBe("agent");
    expect(agentPost!.className).not.toMatch(/bg-primary|bg-violet/);
    expect(agentPost!.getAttribute("data-group-start")).toBe("true");
    // First post after the day rule: no hairline.
    expect(agentPost!.getAttribute("data-rule")).toBeNull();

    expect(userOne!.getAttribute("data-author-kind")).toBe("user");
    expect(userOne!.className).toContain(POST_TINT.user);
    // No accent bar: it competed with the sidebar's connected-agent border.
    expect(userOne!.className).not.toContain("before:w-0.5");
    expect(userOne!.getAttribute("data-group-start")).toBe("true");
    expect(userOne!.getAttribute("data-rule")).toBe("true");
    expect(userOne!.className).toContain("border-t");
    // A grouped row keeps the tint (one block) but no boundary of its own.
    expect(userTwo!.className).toContain(POST_TINT.user);
    expect(userTwo!.getAttribute("data-group-start")).toBeNull();
    expect(userTwo!.getAttribute("data-rule")).toBeNull();
    expect(userTwo!.className).not.toContain("border-t");

    expect(peer.getAttribute("data-author-kind")).toBe("peer");
    expect(peer.className).toContain(POST_TINT.peer);
    expect(peer.getAttribute("data-rule")).toBe("true");

    // Bodies stop at a reading measure; the row itself spans the pane.
    const body = agentPost!.querySelector(".max-w-\\[90ch\\]");
    expect(body?.textContent).toContain("agent one");
    // The copy action floats over the corner; it must not reserve a strip down
    // the full height of the message body.
    expect(body?.parentElement?.className).not.toContain("pr-7");
    const action = agentPost!.querySelector("[data-testid='chat-post-action']");
    expect(action?.className).toContain("float-right");
    expect(action?.className).toContain("max-sm:-mr-2");
    expect(action?.className).toContain("max-sm:-mt-2");
  });

  it("gives the agent a bot avatar and names its engine under it", () => {
    renderFeed([blockEntry(block({ id: "a1" }))], {}, { agentType: "codex" });
    const post = screen.getByTestId("chat-message");
    expect(
      post.querySelector("[data-testid='chat-avatar-agent']")
    ).toBeTruthy();
    expect(
      post.querySelector("[data-testid='chat-author-engine']")?.textContent
    ).toBe("Codex");
  });

  it("shows a sending hint while delivery is pending, and nothing once delivered", () => {
    renderFeed([
      blockEntry(
        block({ id: "u1", authorKind: "user", text: "one", delivered: null })
      ),
      blockEntry(
        block({ id: "u2", authorKind: "user", text: "two", delivered: true })
      ),
    ]);
    const pending = screen.getAllByTestId("chat-delivery-pending");
    expect(pending).toHaveLength(1);
    expect(
      pending[0]!.closest("[data-block-id]")?.getAttribute("data-block-id")
    ).toBe("u1");
    expect(screen.queryByTestId("chat-delivery-failed")).toBeNull();
  });

  it("shows the hold hint instead of the sending hint on a held message", () => {
    renderFeed([
      blockEntry(
        block({
          id: "u1",
          authorKind: "user",
          text: "one",
          delivered: null,
          delivery: [{ agentId: "agt_1", state: "held" }],
        })
      ),
    ]);
    expect(screen.getByTestId("chat-held-hint").textContent).toContain(
      "Queued until the turn ends"
    );
    expect(screen.queryByTestId("chat-delivery-pending")).toBeNull();
  });

  it("shows the hold hint on the queued message only", () => {
    renderFeed([
      blockEntry(block({ id: "u1", authorKind: "user", text: "one" })),
      blockEntry(
        block({
          id: "u2",
          authorKind: "user",
          text: "two",
          delivery: [{ agentId: "agt_1", state: "held" }],
        })
      ),
    ]);
    const hints = screen.getAllByTestId("chat-held-hint");
    expect(hints).toHaveLength(1);
    expect(
      hints[0]!.closest("[data-block-id]")?.getAttribute("data-block-id")
    ).toBe("u2");
  });

  it("renders agent markdown replies", () => {
    renderFeed([blockEntry(block({ id: "a1", text: "Hello **there**" }))]);
    const post = screen.getByTestId("chat-message");
    expect(post.getAttribute("data-author")).toBe("agent");
    expect(post.getAttribute("data-kind")).toBe("text");
    expect(post.querySelector("strong")?.textContent).toBe("there");
    expect(screen.getByTestId("chat-post-author").textContent).toBe("builder");
  });

  it("renders every agent text block the same way: no summary or update treatment", () => {
    renderFeed([
      blockEntry(block({ id: "a1", text: "Done: 3 files" })),
      blockEntry(
        block({
          id: "a2",
          text: "Still going",
          createdAt: "2026-09-02T10:20:00.000Z",
        })
      ),
    ]);
    const [first, second] = screen.getAllByTestId("chat-message");
    expect(first!.querySelector("[data-testid='chat-summary']")).toBeNull();
    expect(first!.textContent).not.toContain("Summary");
    expect(first!.textContent).toContain("Done: 3 files");
    expect(second!.getAttribute("data-kind")).toBe("text");
    expect(second!.textContent).toContain("Still going");
  });

  it("renders an unanswered question with clickable options", () => {
    const { onAnswer } = renderFeed([
      blockEntry(
        block({
          id: "q1",
          text: "Which one?",
          body: questionBody(
            [{ label: "Alpha", value: "a" }, { label: "Beta" }],
            { allowFreeform: true }
          ),
        })
      ),
    ]);
    expect(screen.getByTestId("chat-needs-reply")).toBeTruthy();
    expect(screen.getByText("Or type a reply below.")).toBeTruthy();
    const options = screen.getAllByTestId("chat-question-option");
    expect(options).toHaveLength(2);
    expect(options.every((o) => !(o as HTMLButtonElement).disabled)).toBe(true);

    fireEvent.click(options[1]!);
    expect(onAnswer).toHaveBeenCalledWith("q1", { label: "Beta" });
    // Touch/phone sizing: a 44px target with wrapping labels.
    expect(options[0]!.className).toContain("max-sm:min-h-11");
    expect(options[0]!.className).toContain(
      "[@media(pointer:coarse)]:min-h-11"
    );
  });

  it("marks the chosen option and disables the rest once answered", () => {
    const { onAnswer } = renderFeed([
      blockEntry(
        block({
          id: "q1",
          text: "Which one?",
          body: questionBody(
            [{ label: "Alpha", value: "a" }, { label: "Beta" }],
            { allowFreeform: true, state: answered("a", "Alpha", "u9") }
          ),
        })
      ),
    ]);
    expect(screen.queryByTestId("chat-needs-reply")).toBeNull();
    expect(screen.queryByText("Or type a reply below.")).toBeNull();
    expect(screen.getByTestId("chat-question-options").textContent).toContain(
      "Answered"
    );
    const options = screen.getAllByTestId("chat-question-option");
    expect(options.every((o) => (o as HTMLButtonElement).disabled)).toBe(true);
    expect(options[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(options[1]!.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(options[1]!);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("locks options and hides the freeform hint while answers are unavailable", () => {
    renderFeed(
      [
        blockEntry(
          block({
            id: "q1",
            text: "?",
            body: questionBody([{ label: "Yes" }], { allowFreeform: true }),
          })
        ),
      ],
      { answersDisabled: true }
    );
    const [option] = screen.getAllByTestId("chat-question-option");
    expect((option as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Or type a reply below.")).toBeNull();
    expect(screen.getByTestId("chat-needs-reply")).toBeTruthy();
  });

  it("disables options while an answer is in flight", () => {
    renderFeed(
      [
        blockEntry(
          block({
            id: "q1",
            text: "?",
            body: questionBody([{ label: "Yes" }]),
          })
        ),
      ],
      { answeringBlockId: "q1" }
    );
    const [option] = screen.getAllByTestId("chat-question-option");
    expect((option as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders a file attachment as an image by its MIME type when the name has no extension", () => {
    renderFeed([
      blockEntry(
        block({
          id: "a0",
          attachments: [
            fileAttachment({
              fileId: 9,
              fileName: "clipboard-image",
              sizeBytes: 512,
              mimeType: "image/png",
            }),
            fileAttachment({
              fileId: 10,
              fileName: "archive",
              sizeBytes: 512,
              mimeType: "application/zip",
            }),
          ],
        })
      ),
    ]);
    const image = screen.getByTestId("chat-attachment-image");
    expect(image.querySelector("img")?.getAttribute("src")).toBe(
      `/api/v1/agents/${AGENT_ID}/files/clipboard-image`
    );
    expect(image.querySelector("button")).not.toBeNull();
    expect(screen.getByTestId("chat-attachment-file").textContent).toContain(
      "archive"
    );
  });

  it("serves another agent's image from the agent that owns it, not the page's agent", () => {
    renderFeed(
      [
        blockEntry(
          block({
            id: "kid-shot",
            author: { kind: "agent", agentId: "agt_2" },
            attachments: [
              {
                type: "file",
                fileId: 11,
                fileName: "kid.png",
                sizeBytes: 512,
                mimeType: "image/png",
                ownerAgentId: "agt_2",
              },
            ],
          })
        ),
      ],
      {},
      { peers: REVIEWER_PEER }
    );
    const image = screen.getByTestId("chat-attachment-image");
    expect(image.querySelector("img")?.getAttribute("src")).toBe(
      "/api/v1/agents/agt_2/files/kid.png"
    );
  });

  it("finds the owner of an attachment stored without one from its post", () => {
    renderFeed(
      [
        // An agent's post holds its own files.
        blockEntry(
          block({
            id: "old-kid",
            author: { kind: "agent", agentId: "agt_2" },
            attachments: [
              fileAttachment({
                fileId: 12,
                fileName: "old-kid.png",
                sizeBytes: 512,
              }),
            ],
          })
        ),
        // A person's post holds the files of the agent it was sent to.
        blockEntry(
          block({
            id: "old-user",
            authorKind: "user",
            toAgentId: "agt_2",
            createdAt: "2026-09-02T10:01:00.000Z",
            attachments: [
              fileAttachment({
                fileId: 13,
                fileName: "old-user.png",
                sizeBytes: 512,
              }),
            ],
          })
        ),
      ],
      {},
      { peers: REVIEWER_PEER }
    );
    const sources = screen
      .getAllByTestId("chat-attachment-image")
      .map((image) => image.querySelector("img")?.getAttribute("src"));
    expect(sources).toEqual([
      "/api/v1/agents/agt_2/files/old-kid.png",
      "/api/v1/agents/agt_2/files/old-user.png",
    ]);
  });

  it("renders every attachment type", () => {
    const { onOpenFile } = renderFeed([
      blockEntry(
        block({
          id: "a1",
          attachments: [
            fileAttachment({
              fileId: 7,
              fileName: "shot.png",
              sizeBytes: 2048,
            }),
            fileAttachment({
              fileId: 8,
              fileName: "notes.md",
              sizeBytes: 100,
            }),
            { type: "link", url: "https://example.com/x", title: "Example" },
            { type: "pr", url: "https://github.com/o/r/pull/1" },
            {
              type: "code",
              code: "const a = 1;",
              language: "ts",
              path: "a.ts",
            },
          ],
        })
      ),
    ]);

    const image = screen.getByTestId("chat-attachment-image");
    expect(image.querySelector("img")?.getAttribute("src")).toBe(
      `/api/v1/agents/${AGENT_ID}/files/shot.png`
    );
    fireEvent.click(image.querySelector("button")!);
    expect(onOpenFile).toHaveBeenCalledWith(7);

    expect(screen.getByTestId("chat-attachment-file").textContent).toContain(
      "notes.md"
    );
    const link = screen.getByTestId("chat-attachment-link");
    expect(link.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/x"
    );
    expect(link.textContent).toContain("Example");
    expect(link.textContent).toContain("example.com");
    const pr = screen.getByTestId("chat-attachment-pr");
    expect(pr.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/o/r/pull/1"
    );
    expect(pr.textContent).toContain("https://github.com/o/r/pull/1");
    expect(screen.getByTestId("chat-attachment-code").textContent).toContain(
      "const a = 1;"
    );
    expect(screen.getByTestId("chat-attachment-code").textContent).toContain(
      "a.ts"
    );
  });

  it("renders cross-agent messages as posts by the other agent, or by this one addressed to it", () => {
    renderFeed(
      [
        peerPost({
          id: "am1",
          from: "agt_2",
          to: AGENT_ID,
          text: "LGTM",
          at: "2026-09-02T10:00:00.000Z",
        }),
        peerPost({
          id: "am2",
          from: AGENT_ID,
          to: "agt_2",
          text: "Thanks",
          delivered: false,
          at: "2026-09-02T10:00:01.000Z",
        }),
      ],
      {},
      { peers: REVIEWER_PEER }
    );
    const [incoming, outgoing] = sidePosts();
    expect(
      incoming!.querySelector("[data-testid='chat-post-author']")?.textContent
    ).toBe("Reviewer");
    expect(incoming!.textContent).toContain("LGTM");
    expect(
      outgoing!.querySelector("[data-testid='chat-post-author']")?.textContent
    ).toBe("builder");
    expect(
      outgoing!
        .querySelector("[data-testid='chat-side-header']")
        ?.getAttribute("aria-label")
    ).toBe("builder → Reviewer");
    expect(outgoing!.textContent).toContain("Not delivered");
  });

  it("sets agent-to-agent messages apart as a side conversation", () => {
    const side = (
      id: string,
      direction: "in" | "out",
      second: string,
      content: string,
      delivered: boolean | null = true
    ): StreamEntry =>
      peerPost({
        id,
        from: direction === "in" ? "agt_2" : AGENT_ID,
        to: direction === "in" ? AGENT_ID : "agt_2",
        text: content,
        delivered,
        at: `2026-09-02T10:00:${second}.000Z`,
      });
    renderFeed(
      [
        blockEntry(
          block({
            id: "m1",
            text: "For you",
            createdAt: "2026-09-02T10:00:00.000Z",
          })
        ),
        side("s1", "out", "01", "Can you take a look?", null),
        side("s2", "out", "02", "Second thought"),
        side("s3", "in", "03", "Looking now"),
        blockEntry(
          block({
            id: "m2",
            text: "Back to you",
            createdAt: "2026-09-02T10:00:04.000Z",
          })
        ),
      ],
      {},
      {
        peers: {
          agt_2: { name: "Reviewer", agentType: "codex", relation: "child" },
        },
      }
    );
    const posts = sidePosts();
    expect(posts).toHaveLength(3);
    const [first, second, third] = posts as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];

    // In the same column as every other row (no indent, no muting): the
    // header's "→ recipient" is what says who it was for.
    for (const post of posts) {
      expect(post.getAttribute("data-side")).toBe("true");
      expect(post.className).toContain("px-4");
      expect(post.className).toContain(POST_TINT.peer);
      const body = Array.from(post.querySelectorAll("div")).find((el) =>
        el.className.includes(POST_BODY_MEASURE)
      );
      expect(body?.className).not.toContain("text-muted-foreground");
    }

    // "sender → recipient" header, the relation badge after a peer sender.
    expect(
      first
        .querySelector("[data-testid='chat-side-header']")
        ?.getAttribute("aria-label")
    ).toBe("builder → Reviewer");
    expect(
      first.querySelector("[data-testid='chat-side-recipient']")?.textContent
    ).toBe("→ Reviewer");
    expect(
      first.querySelector("[data-testid='agent-relation-badge']")
    ).toBeNull();
    expect(
      third
        .querySelector("[data-testid='chat-side-header']")
        ?.getAttribute("aria-label")
    ).toBe("Reviewer → builder");
    // The reviewer is this agent's child, and says so under its name.
    expect(
      third.querySelector("[data-testid='agent-relation-badge']")?.textContent
    ).toBe("child agent");

    // Narrow screens: the header wraps and the recipient keeps a minimum
    // width instead of collapsing to "→ …" beside a long sender name.
    const header = first.querySelector("[data-testid='chat-side-header']");
    expect(header?.className).toContain("flex-wrap");
    expect(
      first.querySelector("[data-testid='chat-side-recipient']")?.className
    ).toContain("min-w-[8rem]");
    expect(
      first.querySelector("[data-testid='chat-post-author']")?.className
    ).toContain("max-w-full");

    // The sender's avatar on header rows only, no overlay.
    expect(
      first.querySelector("[data-testid='chat-avatar-agent']")
    ).not.toBeNull();
    expect(
      third.querySelector("[data-testid='chat-avatar-agent']")
    ).not.toBeNull();

    // Same sender → same recipient groups; the reply from the other side
    // starts a new group, and the agent's post to the user right before
    // never grouped with the side conversation.
    expect(first.getAttribute("data-grouped")).toBeNull();
    expect(second.getAttribute("data-grouped")).toBe("true");
    expect(
      second.querySelector("[data-testid='chat-avatar-agent']")
    ).toBeNull();
    expect(third.getAttribute("data-grouped")).toBeNull();
    const ownPosts = screen
      .getAllByTestId("chat-message")
      .filter((el) => !el.hasAttribute("data-to-agent"));
    expect(ownPosts[1]!.getAttribute("data-grouped")).toBeNull();

    // Delivery markers stay.
    expect(
      first.querySelector("[data-testid='chat-delivery-pending']")
    ).not.toBeNull();
    expect(first.textContent).toContain("Sending");
  });

  it("renders a file block as the agent's post with its image, opening the lightbox", () => {
    const { onOpenFile } = renderFeed([
      blockEntry(
        block({
          id: "md1",
          text: "Login page",
          body: FILE_BODY,
          attachments: [
            fileAttachment({
              fileId: 3,
              fileName: "screen.png",
              sizeBytes: 4096,
            }),
          ],
        })
      ),
    ]);
    const card = screen.getByTestId("chat-message");
    expect(card.getAttribute("data-kind")).toBe("file");
    expect(
      card.querySelector("[data-testid='chat-post-author']")?.textContent
    ).toBe("builder");
    expect(card.textContent).toContain("Login page");
    const image = screen.getByTestId("chat-attachment-image");
    expect(image.querySelector("img")).toBeTruthy();
    fireEvent.click(image.querySelector("button")!);
    expect(onOpenFile).toHaveBeenCalledWith(3);
  });
});

describe("ChatFeed enter animation", () => {
  const at = (hhmm: string) => `2026-09-02T${hhmm}:00.000Z`;
  const enterOf = (el: Element) =>
    el.closest('[data-testid="chat-entry-enter"]');

  it("fades in what arrives after the first render, never what was there or paged in above", () => {
    const first = blockEntry(
      block({ id: "a1", text: "first", createdAt: at("10:00") })
    );
    const { rerenderWith } = renderFeed([first]);
    expect(enterOf(screen.getByTestId("chat-message"))).toBeNull();

    // A new post arrives.
    rerenderWith([
      first,
      blockEntry(block({ id: "a2", text: "second", createdAt: at("10:02") })),
    ]);
    const [one, two] = screen.getAllByTestId("chat-message");
    expect(enterOf(one!)).toBeNull();
    expect(enterOf(two!)).not.toBeNull();
    expect(enterOf(two!)!.className).toContain("animate-chat-enter");
    expect(enterOf(two!)!.className).toContain("motion-reduce:animate-none");

    // Still fading when the same list renders again.
    rerenderWith([
      first,
      blockEntry(block({ id: "a2", text: "second", createdAt: at("10:02") })),
    ]);
    expect(enterOf(screen.getAllByTestId("chat-message")[1]!)).not.toBeNull();

    // "Load older" puts an earlier page above: no animation for it.
    rerenderWith([
      blockEntry(block({ id: "a0", text: "older", createdAt: at("09:00") })),
      first,
      blockEntry(block({ id: "a2", text: "second", createdAt: at("10:02") })),
    ]);
    const posts = screen.getAllByTestId("chat-message");
    expect(posts[0]!.textContent).toContain("older");
    expect(enterOf(posts[0]!)).toBeNull();
    expect(enterOf(posts[1]!)).toBeNull();
    expect(enterOf(posts[2]!)).not.toBeNull();
  });

  it("fades in a live row that lands below the newest by time", () => {
    // A child's post published late sorts under the newest post; it is
    // still an arrival, not a page of older rows.
    const first = blockEntry(
      block({ id: "a1", text: "first", createdAt: at("10:00") })
    );
    const last = blockEntry(
      block({ id: "a2", text: "second", createdAt: at("10:05") })
    );
    const { rerenderWith } = renderFeed([first, last]);
    rerenderWith([
      first,
      peerPost({
        id: "late",
        from: "agt_2",
        to: AGENT_ID,
        text: "Landed late",
        at: at("10:03"),
      }),
      last,
    ]);
    expect(enterOf(sidePosts()[0]!)).not.toBeNull();
  });

  it("fades a post edited in place in again", () => {
    const original = block({
      id: "a1",
      text: "draft",
      createdAt: at("10:00"),
      updatedAt: at("10:00"),
    });
    const { rerenderWith } = renderFeed([blockEntry(original)]);
    expect(enterOf(screen.getByTestId("chat-message"))).toBeNull();

    rerenderWith([
      blockEntry({ ...original, text: "final", updatedAt: at("10:05") }),
    ]);
    const edited = screen.getByTestId("chat-message");
    expect(edited.textContent).toContain("final");
    expect(enterOf(edited)).not.toBeNull();
  });
});

describe("reactions", () => {
  it("shows a chip per reaction with its delivery state, and clicking one removes it", () => {
    const onToggleReaction = vi.fn();
    renderFeed(
      [
        blockEntry(
          block({
            id: "m1",
            reactions: [
              reaction("👍", true),
              reaction("🎉", null),
              reaction("👀", false),
            ],
          })
        ),
      ],
      {},
      { onToggleReaction }
    );
    const chips = screen.getAllByTestId("chat-reaction");
    expect(chips.map((chip) => chip.getAttribute("data-emoji"))).toEqual([
      "👍",
      "🎉",
      "👀",
    ]);
    expect(chips.map((chip) => chip.getAttribute("data-delivered"))).toEqual([
      "true",
      "null",
      "false",
    ]);
    expect(chips[2]!.getAttribute("title")).toMatch(/Not delivered/);
    fireEvent.click(chips[0]!);
    expect(onToggleReaction).toHaveBeenCalledWith("m1", "👍", true);
  });

  it("adds a reaction from the picker, and takes back one the message already has", async () => {
    const onToggleReaction = vi.fn();
    renderFeed(
      [blockEntry(block({ id: "m1", reactions: [reaction("👍", true)] }))],
      {},
      { onToggleReaction }
    );
    fireEvent.click(screen.getByTestId("chat-add-reaction"));
    const picker = await screen.findByTestId("chat-reaction-picker");
    const thumbs = within(picker).getByRole("button", {
      name: "Remove 👍 reaction",
    });
    expect(thumbs.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(
      within(picker).getByRole("button", { name: "React with 🎉" })
    );
    expect(onToggleReaction).toHaveBeenCalledWith("m1", "🎉", false);
    await waitFor(() =>
      expect(screen.queryByTestId("chat-reaction-picker")).toBeNull()
    );
    fireEvent.click(screen.getByTestId("chat-add-reaction"));
    fireEvent.click(
      within(await screen.findByTestId("chat-reaction-picker")).getByRole(
        "button",
        { name: "Remove 👍 reaction" }
      )
    );
    expect(onToggleReaction).toHaveBeenLastCalledWith("m1", "👍", true);
  });

  it("shows the agent's reactions on the user's post as labels the user cannot remove", () => {
    const onToggleReaction = vi.fn();
    renderFeed(
      [
        blockEntry(
          block({
            id: "u1",
            authorKind: "user",
            text: "Can you check the logs?",
            delivered: true,
            reactions: [reaction("👀", null, "agent")],
          })
        ),
      ],
      {},
      { onToggleReaction }
    );
    const chip = screen.getByTestId("chat-reaction");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.getAttribute("data-author-kind")).toBe("agent");
    expect(chip.getAttribute("title")).toBe("builder reacted 👀");
    fireEvent.click(chip);
    expect(onToggleReaction).not.toHaveBeenCalled();
  });

  it("offers the picker only on agent messages, and only while messages can be sent", () => {
    const onToggleReaction = vi.fn();
    renderFeed(
      [
        blockEntry(block({ id: "u1", authorKind: "user", text: "mine" })),
        blockEntry(
          block({
            id: "a1",
            createdAt: "2026-09-02T10:10:00.000Z",
          })
        ),
      ],
      {},
      { onToggleReaction }
    );
    const pickers = screen.getAllByTestId("chat-add-reaction");
    expect(pickers).toHaveLength(1);
    expect(
      pickers[0]!.closest("[data-block-id]")?.getAttribute("data-block-id")
    ).toBe("a1");
    cleanup();

    renderFeed(
      [blockEntry(block({ id: "a1", reactions: [reaction("👍", true)] }))],
      { answersDisabled: true },
      { onToggleReaction }
    );
    // Greyed in place rather than removed, with the reason on hover.
    const picker = screen.getByTestId("chat-add-reaction") as HTMLButtonElement;
    expect(picker.disabled).toBe(true);
    expect(
      screen.getByTestId("chat-add-reaction-disabled").getAttribute("title")
    ).toMatch(/can't receive them right now/);
    fireEvent.click(picker);
    expect(screen.queryByTestId("chat-reaction-picker")).toBeNull();
    // A reaction can still be taken back while the agent is stopped.
    expect(
      (screen.getByTestId("chat-reaction") as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("does not offer to remove a reaction whose add is still in flight", () => {
    const onToggleReaction = vi.fn();
    renderFeed(
      [
        blockEntry(
          block({
            id: "a1",
            reactions: [{ ...reaction("🎉", null), id: "optimistic:🎉" }],
          })
        ),
      ],
      {},
      { onToggleReaction }
    );
    const chip = screen.getByTestId("chat-reaction") as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.getAttribute("aria-label")).toBe("Your 🎉 reaction");
    fireEvent.click(chip);
    expect(onToggleReaction).not.toHaveBeenCalled();
  });
});
describe("turn entries", () => {
  const AT = "2026-09-04T10:00:00.000Z";
  const ENDED = "2026-09-04T10:00:09.000Z";
  const READ_STEP: ChatTurnStep = {
    id: "stream:13",
    kind: "read",
    label: "Read README.md",
    status: "ok",
    startedAt: "2026-09-04T10:00:01.000Z",
    endedAt: "2026-09-04T10:00:02.000Z",
    durMs: 1000,
    detail: { toolKind: "read" },
  };
  /**
   * The agent's answer block with its turn attached, settled unless the
   * turn says otherwise. `text` is the block's: the answer once the turn
   * landed, empty while it runs.
   */
  function turn(
    overrides: Partial<ChatTurnEntry> = {},
    text = "It documents the CLI."
  ): StreamEntry {
    return turnEntry({
      id: "turn:12",
      text,
      createdAt: AT,
      turn: {
        updatedAt: ENDED,
        prompt: { source: "chat", text: "read the readme", attachments: [] },
        trace: {
          startedAt: AT,
          endedAt: ENDED,
          finalResult: "ok",
          steps: [READ_STEP],
        },
        ...overrides,
      },
    });
  }
  /** The user's message that opened the turn: a row of its own, above it. */
  const prompt = blockEntry(
    block({
      id: "u1",
      authorKind: "user",
      text: "read the readme",
      delivered: true,
      createdAt: "2026-09-04T09:59:59.000Z",
    })
  );

  it("draws the prompt as the user's row and the answer as the agent's post with its step list", () => {
    const onOpenThread = vi.fn();
    renderFeed(
      [prompt, turn()],
      {},
      { onOpenThread, onToggleReaction: vi.fn() }
    );
    const [user, answer] = screen.getAllByTestId("chat-message");
    expect(user!.getAttribute("data-author")).toBe("user");
    expect(user!.textContent).toContain("read the readme");
    expect(answer!.getAttribute("data-author")).toBe("agent");
    expect(answer!.getAttribute("data-origin")).toBe("turn");
    expect(answer!.getAttribute("data-block-id")).toBe("turn:12");
    expect(answer!.getAttribute("data-group-start")).toBe("true");
    expect(answer!.textContent).toContain("It documents the CLI.");
    // The turn draws no prompt of its own.
    expect(answer!.textContent).not.toContain("read the readme");
    const body = screen.getByTestId("chat-turn");
    expect(body.getAttribute("data-turn-id")).toBe("turn:12");
    expect(body.getAttribute("data-settled")).toBe("true");
    expect(
      body.querySelector('[data-testid="harness-activity-fold"]')
    ).not.toBeNull();
    // A post like any other of the agent's: a thread opens on it and a
    // reaction can land on it.
    fireEvent.click(within(answer!).getByTestId("chat-reply-in-thread"));
    expect(onOpenThread).toHaveBeenCalledWith("turn:12");
    expect(within(answer!).getByTestId("chat-add-reaction")).toBeTruthy();
  });

  it("repaints the same row with the answer once the turn settles", () => {
    const running = turn(
      {
        settled: false,
        result: { text: "so far", streaming: true },
        trace: { startedAt: AT, steps: [READ_STEP] },
      },
      ""
    );
    const { rerenderWith } = renderFeed([prompt, running]);
    const before = screen.getAllByTestId("chat-message")[1]!;
    expect(before.getAttribute("data-block-id")).toBe("turn:12");
    // The reply is in the message as it is written, before it settles.
    expect(before.textContent).toContain("so far");
    expect(screen.getByTestId("chat-turn-live-text")).toBeTruthy();
    expect(
      screen.getByTestId("chat-turn").getAttribute("data-settled")
    ).toBeNull();
    rerenderWith([prompt, turn()]);
    const after = screen.getAllByTestId("chat-message")[1]!;
    expect(after.getAttribute("data-block-id")).toBe("turn:12");
    expect(after.textContent).toContain("It documents the CLI.");
    expect(screen.getByTestId("chat-turn").getAttribute("data-settled")).toBe(
      "true"
    );
  });

  it("shows a turn run by another agent as a post under that agent's name", () => {
    renderFeed(
      [
        turnEntry({
          id: "turn:kid",
          author: { kind: "agent", agentId: "agt_2" },
          text: "Reviewed.",
          createdAt: AT,
        }),
      ],
      {},
      { peers: REVIEWER_PEER }
    );
    const post = screen.getByTestId("chat-message");
    expect(post.getAttribute("data-author")).toBe("peer");
    expect(post.getAttribute("data-origin")).toBe("turn");
    expect(screen.getByTestId("chat-post-author").textContent).toBe("Reviewer");
    expect(post.textContent).toContain("Reviewed.");
    expect(screen.getByTestId("chat-turn").getAttribute("data-turn-id")).toBe(
      "turn:kid"
    );
  });

  it("lifts what the agent produced mid-turn into the turn's post", () => {
    const file = blockEntry(
      block({
        id: "md1",
        text: "Login page",
        body: FILE_BODY,
        attachments: [
          fileAttachment({ fileId: 3, fileName: "screen.png", sizeBytes: 1 }),
        ],
        createdAt: "2026-09-04T10:00:03.000Z",
      })
    );
    renderFeed([prompt, turn(), file]);
    const posts = screen.getAllByTestId("chat-message");
    expect(posts.map((p) => p.getAttribute("data-block-id"))).toEqual([
      "u1",
      "turn:12",
    ]);
    expect(
      within(posts[1]!).getByTestId("chat-turn-attachments").textContent
    ).toContain("Login page");
  });

  it("keeps a turn out of every author group and resets the run behind it", () => {
    const rows = layoutFeed(
      [
        blockEntry(
          block({
            id: "m1",
            authorKind: "agent",
            text: "before",
            createdAt: "2026-09-04T09:59:00.000Z",
            updatedAt: "2026-09-04T09:59:00.000Z",
          })
        ),
        turn(),
        blockEntry(
          block({
            id: "m2",
            authorKind: "agent",
            text: "after",
            createdAt: "2026-09-04T10:00:10.000Z",
            updatedAt: "2026-09-04T10:00:10.000Z",
          })
        ),
      ],
      makeCtx(),
      new Date("2026-09-04T12:00:00.000Z")
    );
    const entries = rows.filter((r) => r.kind === "entry");
    expect(entries.map((r) => [r.entry.id, r.grouped, r.rule])).toEqual([
      ["m1", false, false],
      ["turn:12", false, false],
      // Two agent posts five minutes apart would group; the turn between
      // them ends the run, so the second opens a fresh header.
      ["m2", false, true],
    ]);
  });

  it("keys a turn's growth on its newest row, steps, answer and settled state", () => {
    const running = { settled: false, result: { text: "a", streaming: true } };
    const base = turn(running, "");
    const grown = turn(
      { ...running, updatedAt: "2026-09-04T10:00:11.000Z" },
      ""
    );
    expect(entryGrowthKey(base)).not.toBe(entryGrowthKey(grown));
    const stepped = turn(
      {
        ...running,
        trace: {
          startedAt: AT,
          steps: [READ_STEP, { ...READ_STEP, id: "stream:14" }],
        },
      },
      ""
    );
    expect(entryGrowthKey(stepped)).not.toBe(entryGrowthKey(base));
    // Landing: the block takes the answer as its text and the turn settles.
    const landed = turn();
    expect(entryGrowthKey(grown)).not.toBe(entryGrowthKey(landed));
    // The fade-in version is the block's birth, which never moves, so
    // neither growth nor the landing remounts the entry and collapses an
    // expanded step.
    expect(entryVersion(base)).toBe(entryVersion(grown));
    expect(entryVersion(base)).toBe(entryVersion(landed));
  });

  it("does not re-enter a streaming turn as it grows", () => {
    const running = { settled: false, result: { text: "a", streaming: true } };
    const { result, rerender } = renderHook(
      ({ entries }: { entries: StreamEntry[] }) => useEnteringEntries(entries),
      { initialProps: { entries: [turn(running, "")] } }
    );
    const later = blockEntry(
      block({
        id: "u9",
        authorKind: "user",
        text: "and then?",
        createdAt: "2026-09-04T10:00:20.000Z",
      })
    );
    rerender({ entries: [turn(running, ""), later] });
    expect(result.current.has("u9")).toBe(true);
    rerender({
      entries: [
        turn(
          {
            ...running,
            updatedAt: "2026-09-04T10:00:15.000Z",
            result: { text: "abc", streaming: true },
          },
          ""
        ),
        later,
      ],
    });
    expect(result.current.has("turn:12")).toBe(false);
  });

  it("takes a turn's word for a question its own chat row has not caught up on", () => {
    const question = block({
      id: "q1",
      authorKind: "agent",
      text: "Scope choice?",
      body: questionBody([{ label: "Narrow" }], { allowFreeform: true }),
      createdAt: "2026-09-04T10:00:05.000Z",
      updatedAt: "2026-09-04T10:00:05.000Z",
    });
    // The card still says unanswered, and no turn contradicts it.
    expect(
      latestOpenFreeformQuestion([
        turn({ questions: [{ messageId: "q1", answered: false }] }),
        blockEntry(question),
      ])?.id
    ).toBe("q1");
    // The turn is republished on every flush, so its answered state is the
    // fresher one: the composer stops offering to answer a closed question.
    expect(
      latestOpenFreeformQuestion([
        turn({ questions: [{ messageId: "q1", answered: true }] }),
        blockEntry(question),
      ])
    ).toBeNull();
    // A turn that names no question changes nothing.
    expect(latestOpenFreeformQuestion([turn(), blockEntry(question)])?.id).toBe(
      "q1"
    );
  });
});

describe("@mentions in a person's post", () => {
  it("says whom the post was for and paints the names", () => {
    const peers = {
      agt_rev: {
        name: "reviewer",
        agentType: "codex",
        relation: "child" as const,
        seat: 2,
      },
      agt_build: {
        name: "builder",
        agentType: "claude",
        relation: "child" as const,
        seat: 3,
      },
    };
    renderFeed(
      [
        blockEntry(
          block({
            id: "m1",
            authorKind: "user",
            text: "@builder take it, @reviewer check it",
            toAgentId: "agt_build",
            body: {
              kind: "text",
              data: { mentions: ["agt_build", "agt_rev"] },
              state: null,
            },
          })
        ),
        blockEntry(
          block({
            id: "m2",
            authorKind: "user",
            text: "plain, for the page's agent",
          })
        ),
      ],
      {},
      { peers, agentSeat: 1 }
    );
    const posts = screen.getAllByTestId("chat-message");
    expect(
      posts[0]!.querySelector('[data-testid="chat-side-recipient"]')
        ?.textContent
    ).toContain("builder, reviewer");
    expect(
      posts[0]!.querySelectorAll('[data-testid="chat-mention"]')
    ).toHaveLength(2);
    // A post for the page's own agent says nothing about it.
    expect(
      posts[1]!.querySelector('[data-testid="chat-side-recipient"]')
    ).toBeNull();
  });
});
