// @vitest-environment jsdom
import type {
  ChatAttachment,
  ChatFeedEntry,
  ChatMessage,
  ChatStatusEntry,
} from "@dispatch/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type AttachmentContext } from "@/components/app/chat/chat-entries";
import {
  ChatFeed,
  collapseFeed,
  latestAgentMessageId,
  latestOpenFreeformQuestion,
  latestUserMessageId,
  layoutFeed,
} from "@/components/app/chat/chat-feed";

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
});

const AGENT_ID = "agt_1";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: overrides.id ?? `msg_${Math.random().toString(36).slice(2, 8)}`,
    agentId: AGENT_ID,
    authorKind: "agent",
    kind: "reply",
    text: "Hello **there**",
    replyTo: null,
    question: null,
    answer: null,
    attachments: [],
    delivered: null,
    readAt: null,
    createdAt: "2026-09-02T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  };
}

function fileAttachment(
  fields: Pick<
    Extract<ChatAttachment, { type: "file" }>,
    "mediaId" | "fileName" | "sizeBytes"
  >
): ChatAttachment {
  return { type: "file", ...fields };
}

function chat(m: ChatMessage): ChatFeedEntry {
  return { type: "chat", id: m.id, at: m.createdAt, message: m };
}

function status(
  id: string,
  eventType: string,
  text: string,
  at = "2026-09-02T10:00:00.000Z"
): ChatStatusEntry {
  return { type: "status", id, eventType, message: text, at };
}

function makeCtx(
  overrides: Partial<AttachmentContext> = {},
  onOpenMedia = vi.fn()
): AttachmentContext {
  return {
    agentId: AGENT_ID,
    agentName: "builder",
    agentType: "claude",
    pins: [],
    workspaceRoot: null,
    onOpenMedia,
    ...overrides,
  };
}

function renderFeed(
  entries: ChatFeedEntry[],
  extra: Partial<Parameters<typeof ChatFeed>[0]> = {},
  ctxOverrides: Partial<AttachmentContext> = {}
) {
  const onAnswer = vi.fn();
  const onOpenMedia = vi.fn();
  const ctx = makeCtx(ctxOverrides, onOpenMedia);
  render(
    <MemoryRouter>
      <ChatFeed
        entries={entries}
        ctx={ctx}
        heldMessageId={null}
        answeringMessageId={null}
        onAnswer={onAnswer}
        {...extra}
      />
    </MemoryRouter>
  );
  return { onAnswer, onOpenMedia };
}

describe("collapseFeed", () => {
  it("folds consecutive working events into the latest one", () => {
    const items = collapseFeed([
      status("s1", "working", "Reading files"),
      status("s2", "working", "Editing"),
      status("s3", "working", "Running tests"),
      status("s4", "done", "All green"),
      status("s5", "working", "Again"),
    ]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      kind: "status",
      collapsedCount: 3,
      entry: { id: "s3", message: "Running tests" },
    });
    expect(items[1]).toMatchObject({ kind: "status", collapsedCount: 1 });
    expect(items[2]).toMatchObject({
      kind: "status",
      collapsedCount: 1,
      entry: { id: "s5" },
    });
  });

  it("breaks a working run on any non-status entry", () => {
    const items = collapseFeed([
      status("s1", "working", "a"),
      chat(message({ id: "m1" })),
      status("s2", "working", "b"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["status", "entry", "status"]);
  });
});

describe("layoutFeed", () => {
  const now = new Date("2026-09-03T12:00:00.000Z");
  const at = (hhmm: string, day = "02") => `2026-09-${day}T${hhmm}:00.000Z`;

  it("groups same-author posts within five minutes and breaks on author change", () => {
    const rows = layoutFeed(
      [
        chat(message({ id: "a1", createdAt: at("10:00") })),
        chat(message({ id: "a2", createdAt: at("10:03") })),
        chat(message({ id: "u1", authorKind: "user", createdAt: at("10:04") })),
        chat(message({ id: "a3", createdAt: at("10:05") })),
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

  it("starts a new group after five minutes or a system line", () => {
    const rows = layoutFeed(
      [
        chat(message({ id: "a1", createdAt: at("10:00") })),
        chat(message({ id: "a2", createdAt: at("10:06") })),
        status("s1", "working", "x", at("10:07")),
        chat(message({ id: "a3", createdAt: at("10:07") })),
      ],
      makeCtx(),
      now
    );
    expect(
      rows.map((r) => (r.kind === "entry" ? [r.entry.id, r.grouped] : r.kind))
    ).toEqual([
      "divider",
      ["a1", false],
      ["a2", false],
      "status",
      ["a3", false],
    ]);
  });

  it("treats media and outgoing agent messages as the agent's own posts", () => {
    const rows = layoutFeed(
      [
        chat(message({ id: "a1", createdAt: at("10:00") })),
        {
          type: "media",
          id: "md1",
          mediaId: 1,
          fileName: "x.png",
          sizeBytes: 1,
          description: null,
          at: at("10:01"),
        },
        {
          type: "agent_message",
          id: "am1",
          direction: "out",
          senderAgentId: AGENT_ID,
          senderName: "builder",
          recipientAgentId: "agt_2",
          recipientName: "Reviewer",
          content: "ping",
          delivered: true,
          at: at("10:02"),
        },
        {
          type: "agent_message",
          id: "am2",
          direction: "in",
          senderAgentId: "agt_2",
          senderName: "Reviewer",
          recipientAgentId: AGENT_ID,
          recipientName: "builder",
          content: "pong",
          delivered: true,
          at: at("10:03"),
        },
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
      ["am1", true],
      ["am2", false],
    ]);
  });

  it("puts a labelled rule between days", () => {
    const rows = layoutFeed(
      [
        chat(message({ id: "a1", createdAt: at("10:00", "01") })),
        chat(message({ id: "a2", createdAt: at("10:00", "02") })),
        chat(message({ id: "a3", createdAt: at("10:00", "03") })),
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
      chat(message({ id: "a1" })),
      chat(message({ id: "u1", authorKind: "user" })),
      chat(message({ id: "a2" })),
      status("s1", "working", "x"),
    ];
    expect(latestUserMessageId(entries)).toBe("u1");
    expect(latestAgentMessageId(entries)).toBe("a2");
    expect(latestUserMessageId([])).toBeNull();
  });
});

describe("latestOpenFreeformQuestion", () => {
  const freeform = (id: string, answered = false) =>
    chat(
      message({
        id,
        kind: "question",
        text: `Q ${id}`,
        question: { options: [{ label: "A" }], allowFreeform: true },
        answer: answered
          ? {
              value: "A",
              replyMessageId: "r",
              answeredAt: "2026-09-02T10:01:00.000Z",
            }
          : null,
      })
    );
  const fixed = (id: string) =>
    chat(
      message({
        id,
        kind: "question",
        text: `Q ${id}`,
        question: { options: [{ label: "A" }] },
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
      latestOpenFreeformQuestion([chat(message({ id: "a1" }))])
    ).toBeNull();
  });

  it("looks past later replies to the open question", () => {
    expect(
      latestOpenFreeformQuestion([freeform("q1"), chat(message({ id: "a2" }))])
        ?.id
    ).toBe("q1");
  });
});

describe("ChatFeed", () => {
  it('renders a user post under a "You" header with delivery failure marker', () => {
    renderFeed([
      chat(
        message({
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

  it("collapses consecutive posts by one author under a single header", () => {
    renderFeed([
      chat(message({ id: "a1", text: "first" })),
      chat(
        message({
          id: "a2",
          text: "second",
          createdAt: "2026-09-02T10:02:00.000Z",
        })
      ),
      chat(
        message({
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

  it("uses the agent's type for its avatar", () => {
    renderFeed([chat(message({ id: "a1" }))], {}, { agentType: "codex" });
    const post = screen.getByTestId("chat-message");
    expect(post.querySelector("[aria-label='Codex agent']")).toBeTruthy();
  });

  it("shows a sending hint while delivery is pending, and nothing once delivered", () => {
    renderFeed([
      chat(
        message({ id: "u1", authorKind: "user", text: "one", delivered: null })
      ),
      chat(
        message({ id: "u2", authorKind: "user", text: "two", delivered: true })
      ),
    ]);
    const pending = screen.getAllByTestId("chat-delivery-pending");
    expect(pending).toHaveLength(1);
    expect(
      pending[0]!.closest("[data-message-id]")?.getAttribute("data-message-id")
    ).toBe("u1");
    expect(screen.queryByTestId("chat-delivery-failed")).toBeNull();
  });

  it("shows the hold hint instead of the sending hint on a held message", () => {
    renderFeed(
      [
        chat(
          message({
            id: "u1",
            authorKind: "user",
            text: "one",
            delivered: null,
          })
        ),
      ],
      { heldMessageId: "u1" }
    );
    expect(screen.getByTestId("chat-held-hint")).toBeTruthy();
    expect(screen.queryByTestId("chat-delivery-pending")).toBeNull();
  });

  it("shows the hold hint on the held user message only", () => {
    renderFeed(
      [
        chat(message({ id: "u1", authorKind: "user", text: "one" })),
        chat(message({ id: "u2", authorKind: "user", text: "two" })),
      ],
      { heldMessageId: "u2" }
    );
    const hints = screen.getAllByTestId("chat-held-hint");
    expect(hints).toHaveLength(1);
    expect(
      hints[0]!.closest("[data-message-id]")?.getAttribute("data-message-id")
    ).toBe("u2");
  });

  it("renders agent markdown replies", () => {
    renderFeed([chat(message({ id: "a1", text: "Hello **there**" }))]);
    const post = screen.getByTestId("chat-message");
    expect(post.getAttribute("data-author")).toBe("agent");
    expect(post.getAttribute("data-kind")).toBe("reply");
    expect(post.querySelector("strong")?.textContent).toBe("there");
    expect(screen.getByTestId("chat-post-author").textContent).toBe("builder");
  });

  it("renders a summary as an accented block and an update as a light post", () => {
    renderFeed([
      chat(message({ id: "a1", kind: "summary", text: "Done: 3 files" })),
      chat(message({ id: "a2", kind: "update", text: "Still going" })),
    ]);
    const [summary, update] = screen.getAllByTestId("chat-message");
    expect(summary!.querySelector("[data-testid='chat-summary']")).toBeTruthy();
    expect(summary!.textContent).toContain("Summary");
    expect(summary!.textContent).toContain("Done: 3 files");
    expect(update!.getAttribute("data-kind")).toBe("update");
    expect(update!.textContent).toContain("Still going");
  });

  it("renders an unanswered question with clickable options", () => {
    const { onAnswer } = renderFeed([
      chat(
        message({
          id: "q1",
          kind: "question",
          text: "Which one?",
          question: {
            options: [{ label: "Alpha", value: "a" }, { label: "Beta" }],
            allowFreeform: true,
          },
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
      chat(
        message({
          id: "q1",
          kind: "question",
          text: "Which one?",
          question: {
            options: [{ label: "Alpha", value: "a" }, { label: "Beta" }],
            allowFreeform: true,
          },
          answer: {
            value: "a",
            label: "Alpha",
            replyMessageId: "u9",
            answeredAt: "2026-09-02T10:01:00.000Z",
          },
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
        chat(
          message({
            id: "q1",
            kind: "question",
            text: "?",
            question: { options: [{ label: "Yes" }], allowFreeform: true },
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
        chat(
          message({
            id: "q1",
            kind: "question",
            text: "?",
            question: { options: [{ label: "Yes" }] },
          })
        ),
      ],
      { answeringMessageId: "q1" }
    );
    const [option] = screen.getAllByTestId("chat-question-option");
    expect((option as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders every attachment type", () => {
    const { onOpenMedia } = renderFeed(
      [
        chat(
          message({
            id: "a1",
            attachments: [
              fileAttachment({
                mediaId: 7,
                fileName: "shot.png",
                sizeBytes: 2048,
              }),
              fileAttachment({
                mediaId: 8,
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
              { type: "pin", pinId: "pin_1" },
              { type: "pin", pinId: "pin_missing" },
            ],
          })
        ),
      ],
      {},
      {
        pins: [
          { id: "pin_1", label: "Dev URL", value: "http://x", type: "url" },
        ],
      }
    );

    const image = screen.getByTestId("chat-attachment-image");
    expect(image.querySelector("img")?.getAttribute("src")).toBe(
      `/api/v1/agents/${AGENT_ID}/media/shot.png`
    );
    fireEvent.click(image.querySelector("button")!);
    expect(onOpenMedia).toHaveBeenCalledWith(
      expect.objectContaining({ name: "shot.png", size: 2048 })
    );

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
    expect(screen.getByTestId("chat-attachment-pin").textContent).toContain(
      "Dev URL"
    );
    expect(screen.getByTestId("chat-attachment-pin-missing")).toBeTruthy();
  });

  it("renders status lines with a collapsed count", () => {
    renderFeed([
      status("s1", "working", "Reading"),
      status("s2", "working", "Testing"),
      status("s3", "blocked", "Need a key"),
    ]);
    const lines = screen.getAllByTestId("chat-status");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toContain("Working");
    expect(lines[0]!.textContent).toContain("Testing");
    expect(lines[0]!.textContent).not.toContain("Reading");
    expect(screen.getByTestId("chat-status-collapsed-count").textContent).toBe(
      "×2"
    );
    expect(lines[1]!.textContent).toContain("Blocked");
    expect(lines[1]!.textContent).toContain("Need a key");
  });

  it("renders cross-agent messages as posts by the other agent, or by this one addressed to it", () => {
    renderFeed([
      {
        type: "agent_message",
        id: "am1",
        direction: "in",
        senderAgentId: "agt_2",
        senderName: "Reviewer",
        recipientAgentId: AGENT_ID,
        recipientName: "Me",
        content: "LGTM",
        delivered: true,
        at: "2026-09-02T10:00:00.000Z",
      },
      {
        type: "agent_message",
        id: "am2",
        direction: "out",
        senderAgentId: AGENT_ID,
        senderName: "Me",
        recipientAgentId: "agt_2",
        recipientName: "Reviewer",
        content: "Thanks",
        delivered: false,
        at: "2026-09-02T10:00:01.000Z",
      },
    ]);
    const [incoming, outgoing] = screen.getAllByTestId("chat-agent-message");
    expect(
      incoming!.querySelector("[data-testid='chat-post-author']")?.textContent
    ).toBe("Reviewer");
    expect(incoming!.textContent).toContain("LGTM");
    expect(
      outgoing!.querySelector("[data-testid='chat-post-author']")?.textContent
    ).toBe("builder");
    expect(outgoing!.textContent).toContain("to Reviewer");
    expect(outgoing!.textContent).toContain("Not delivered");
  });

  it("renders media entries and opens them in the lightbox", () => {
    const { onOpenMedia } = renderFeed([
      {
        type: "media",
        id: "md1",
        mediaId: 3,
        fileName: "screen.png",
        sizeBytes: 4096,
        description: "Login page",
        at: "2026-09-02T10:00:00.000Z",
      },
    ]);
    const card = screen.getByTestId("chat-media");
    expect(
      card.querySelector("[data-testid='chat-post-author']")?.textContent
    ).toBe("builder");
    expect(card.textContent).toContain("Login page");
    expect(card.querySelector("img")).toBeTruthy();
    fireEvent.click(card.querySelector("button")!);
    expect(onOpenMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "screen.png",
        url: `/api/v1/agents/${AGENT_ID}/media/screen.png`,
      })
    );
  });
});
