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

type FileAttachment = Extract<ChatAttachment, { type: "file" }>;

function fileAttachment(
  fields: Pick<FileAttachment, "mediaId" | "fileName" | "sizeBytes">
): ChatAttachment {
  return { type: "file", ...fields } as FileAttachment;
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

function renderFeed(
  entries: ChatFeedEntry[],
  extra: Partial<Parameters<typeof ChatFeed>[0]> = {},
  ctxOverrides: Partial<AttachmentContext> = {}
) {
  const onAnswer = vi.fn();
  const onOpenMedia = vi.fn();
  const ctx: AttachmentContext = {
    agentId: AGENT_ID,
    pins: [],
    workspaceRoot: null,
    onOpenMedia,
    ...ctxOverrides,
  };
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
  it("renders a user bubble with delivery failure marker", () => {
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
    const bubble = screen.getByTestId("chat-message");
    expect(bubble.getAttribute("data-author")).toBe("user");
    expect(bubble.textContent).toContain("Ship it");
    expect(screen.getByTestId("chat-delivery-failed")).toBeTruthy();
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
    const bubble = screen.getByTestId("chat-message");
    expect(bubble.getAttribute("data-author")).toBe("agent");
    expect(bubble.getAttribute("data-kind")).toBe("reply");
    expect(bubble.querySelector("strong")?.textContent).toBe("there");
  });

  it("renders a summary as a headed card and an update as a light line", () => {
    renderFeed([
      chat(message({ id: "a1", kind: "summary", text: "Done: 3 files" })),
      chat(message({ id: "a2", kind: "update", text: "Still going" })),
    ]);
    const [summary, update] = screen.getAllByTestId("chat-message");
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
    fireEvent.click(image);
    expect(onOpenMedia).toHaveBeenCalledWith(
      expect.objectContaining({ name: "shot.png", size: 2048 })
    );

    expect(screen.getByTestId("chat-attachment-file").textContent).toContain(
      "notes.md"
    );
    expect(screen.getByText("Example").closest("a")?.getAttribute("href")).toBe(
      "https://example.com/x"
    );
    expect(
      screen.getByText("https://github.com/o/r/pull/1").closest("a")
    ).toBeTruthy();
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

  it("renders cross-agent messages with the other agent's name", () => {
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
    expect(incoming!.textContent).toContain("From Reviewer");
    expect(incoming!.textContent).toContain("LGTM");
    expect(outgoing!.textContent).toContain("To Reviewer");
    expect(outgoing!.textContent).toContain("not delivered");
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
