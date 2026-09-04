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

import {
  type FeedContext,
  POST_BODY_MEASURE,
  SIDE_POST_INDENT,
  peerDirectory,
  POST_TINT,
} from "@/components/app/chat/chat-entries";
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
    "mediaId" | "fileName" | "sizeBytes" | "mimeType"
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
  overrides: Partial<FeedContext> = {},
  onOpenMedia = vi.fn()
): FeedContext {
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

function feedElement(
  entries: ChatFeedEntry[],
  ctx: FeedContext,
  onAnswer: ReturnType<typeof vi.fn>,
  extra: Partial<Parameters<typeof ChatFeed>[0]> = {}
) {
  return (
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
}

function renderFeed(
  entries: ChatFeedEntry[],
  extra: Partial<Parameters<typeof ChatFeed>[0]> = {},
  ctxOverrides: Partial<FeedContext> = {}
) {
  const onAnswer = vi.fn();
  const onOpenMedia = vi.fn();
  const ctx = makeCtx(ctxOverrides, onOpenMedia);
  const view = render(feedElement(entries, ctx, onAnswer, extra));
  const rerenderWith = (next: ChatFeedEntry[]) =>
    view.rerender(feedElement(next, ctx, onAnswer, extra));
  return { onAnswer, onOpenMedia, rerenderWith };
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

  it("draws a rule only where a new author group follows another post directly", () => {
    const rows = layoutFeed(
      [
        chat(message({ id: "a1", createdAt: at("10:00") })),
        chat(message({ id: "a2", createdAt: at("10:01") })),
        chat(message({ id: "u1", authorKind: "user", createdAt: at("10:02") })),
        status("s1", "working", "x", at("10:03")),
        chat(message({ id: "a3", createdAt: at("10:03") })),
        chat(message({ id: "a4", createdAt: at("10:00", "03") })),
        chat(
          message({
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
      // Author change straight after a post: hairline.
      ["u1", true],
      // A status cluster sits between: no second separator.
      ["a3", false],
      // Day rule again.
      ["a4", false],
      ["u2", true],
    ]);
  });

  it("groups media with the agent's posts but keeps a side conversation apart", () => {
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

  it("shows a peer's own icon and its relation to this agent", () => {
    const peers = peerDirectory(AGENT_ID, [
      {
        id: AGENT_ID,
        name: "builder",
        type: "claude",
        parentAgentId: "agt_root",
      },
      { id: "agt_kid", name: "kid", type: "codex", parentAgentId: AGENT_ID },
      { id: "agt_root", name: "root", type: "claude", parentAgentId: null },
      {
        id: "agt_sib",
        name: "sib",
        type: "opencode",
        parentAgentId: "agt_root",
      },
      { id: "agt_far", name: "far", type: "terminal", parentAgentId: null },
    ]);
    expect(peers[AGENT_ID]).toBeUndefined();
    const peerPost = (
      id: string,
      senderAgentId: string,
      minute: string
    ): ChatFeedEntry => ({
      type: "agent_message",
      id,
      direction: "in",
      senderAgentId,
      senderName: senderAgentId,
      recipientAgentId: AGENT_ID,
      recipientName: "builder",
      content: `from ${senderAgentId}`,
      delivered: true,
      at: `2026-09-02T10:${minute}:00.000Z`,
    });
    renderFeed(
      [
        peerPost("p1", "agt_kid", "00"),
        peerPost("p2", "agt_root", "10"),
        peerPost("p3", "agt_sib", "20"),
        peerPost("p4", "agt_far", "30"),
        peerPost("p5", "agt_gone", "40"),
      ],
      {},
      { peers }
    );
    const posts = screen.getAllByTestId("chat-agent-message");
    expect(
      posts.map(
        (post) =>
          post.querySelector('[data-testid="agent-relation-badge"]')
            ?.textContent
      )
    ).toEqual(["child agent", "parent", "sibling", "agent", "agent"]);
    expect(
      posts.map((post) =>
        post.querySelector('[aria-label$=" agent"]')?.getAttribute("aria-label")
      )
    ).toEqual([
      "Codex agent",
      "Claude agent",
      "OpenCode agent",
      "Terminal agent",
      // Not in the list any more: the generic agent icon.
      "Agent agent",
    ]);
    // Still a peer post: muted side-conversation treatment, sender's name.
    expect(posts[0]!.className).toContain(POST_TINT.peer);
    expect(
      posts[0]!.querySelector('[data-testid="chat-post-author"]')?.textContent
    ).toBe("agt_kid");
  });

  it("falls back to a plain agent for a peer before the agent list has loaded", () => {
    renderFeed([
      {
        type: "agent_message",
        id: "p1",
        direction: "in",
        senderAgentId: "agt_2",
        senderName: "Reviewer",
        recipientAgentId: AGENT_ID,
        recipientName: "builder",
        content: "hi",
        delivered: true,
        at: "2026-09-02T10:00:00.000Z",
      },
    ]);
    const post = screen.getByTestId("chat-agent-message");
    expect(
      post.querySelector('[data-testid="agent-relation-badge"]')?.textContent
    ).toBe("agent");
    expect(post.querySelector('[aria-label="Agent agent"]')).not.toBeNull();
    // This agent's own outgoing posts carry no badge.
  });

  it("gives the agent's own outgoing message its icon and no relation badge", () => {
    renderFeed([
      {
        type: "agent_message",
        id: "o1",
        direction: "out",
        senderAgentId: AGENT_ID,
        senderName: "builder",
        recipientAgentId: "agt_2",
        recipientName: "Reviewer",
        content: "ping",
        delivered: true,
        at: "2026-09-02T10:00:00.000Z",
      },
    ]);
    const post = screen.getByTestId("chat-agent-message");
    expect(
      post.querySelector('[data-testid="agent-relation-badge"]')
    ).toBeNull();
    expect(post.querySelector('[aria-label="Claude agent"]')).not.toBeNull();
    expect(
      post
        .querySelector("[data-testid='chat-side-header']")
        ?.getAttribute("aria-label")
    ).toBe("builder → Reviewer");
  });

  it('labels a launch-context post "Launch context" and keeps it a You post', () => {
    const launch = message({
      id: "launch",
      authorKind: "user",
      origin: "launch",
      text: "Build the widget",
      attachments: [
        { type: "link", url: "https://example.com/spec" },
        fileAttachment({ mediaId: 7, fileName: "brief.md", sizeBytes: 300 }),
      ],
      delivered: true,
      createdAt: "2026-09-02T10:00:00.000Z",
    });
    const followUp = message({
      id: "follow",
      authorKind: "user",
      text: "Also add tests",
      delivered: true,
      createdAt: "2026-09-02T10:01:00.000Z",
    });
    renderFeed([chat(launch), chat(followUp)]);
    const posts = screen.getAllByTestId("chat-message");
    expect(posts[0]?.getAttribute("data-origin")).toBe("launch");
    expect(posts[0]?.getAttribute("data-author-kind")).toBe("user");
    expect(screen.getByTestId("chat-launch-context").textContent).toContain(
      "Launch context"
    );
    expect(screen.getByTestId("chat-post-author").textContent).toBe("You");
    expect(screen.getByTestId("chat-avatar-user")).toBeTruthy();
    expect(screen.getByTestId("chat-attachment-link")).toBeTruthy();
    expect(screen.getByTestId("chat-attachment-file")).toBeTruthy();
    expect(screen.getByText("Build the widget")).toBeTruthy();
    // No delivery marker: the prompt went out with the launch.
    expect(screen.queryByTestId("chat-delivery-pending")).toBeNull();
    expect(screen.queryByTestId("chat-delivery-failed")).toBeNull();
    // Grouping treats it like any You post: the next one collapses under it.
    expect(posts.map((p) => p.getAttribute("data-grouped"))).toEqual([
      null,
      "true",
    ]);
  });

  it("attributes a launched-by post to the launching agent, falling back to Agent", () => {
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
    const launch = message({
      id: "launch",
      authorKind: "user",
      origin: "launch",
      launchedByAgentId: "agt_root",
      text: "Build the widget",
      delivered: true,
      createdAt: "2026-09-02T10:00:00.000Z",
    });
    renderFeed([chat(launch)], {}, { peers });
    let post = screen.getByTestId("chat-message");
    expect(post.getAttribute("data-author-kind")).toBe("peer");
    expect(post.getAttribute("data-launched-by")).toBe("agt_root");
    expect(screen.getByTestId("chat-launch-context")).toBeTruthy();
    expect(screen.getByTestId("chat-post-author").textContent).toBe(
      "orchestrator"
    );
    expect(screen.getByTestId("agent-relation-badge").textContent).toBe(
      "parent"
    );
    expect(
      post.querySelector('[aria-label$=" agent"]')?.getAttribute("aria-label")
    ).toBe("Codex agent");
    expect(screen.queryByTestId("chat-avatar-user")).toBeNull();
    cleanup();

    // The launcher is gone from the list: still a peer post, generic name.
    renderFeed([chat(launch)], {}, { peers: {} });
    post = screen.getByTestId("chat-message");
    expect(screen.getByTestId("chat-post-author").textContent).toBe("Agent");
    expect(screen.getByTestId("agent-relation-badge").textContent).toBe(
      "agent"
    );
    expect(screen.getByTestId("chat-launch-context")).toBeTruthy();
  });

  it("tints You and peer posts, leaves the agent's plain, and marks group boundaries", () => {
    renderFeed([
      chat(message({ id: "a1", text: "agent one" })),
      chat(
        message({
          id: "u1",
          authorKind: "user",
          text: "user one",
          createdAt: "2026-09-02T10:01:00.000Z",
        })
      ),
      chat(
        message({
          id: "u2",
          authorKind: "user",
          text: "user two",
          createdAt: "2026-09-02T10:02:00.000Z",
        })
      ),
      {
        type: "agent_message",
        id: "am1",
        direction: "in",
        senderAgentId: "agt_2",
        senderName: "Reviewer",
        recipientAgentId: AGENT_ID,
        recipientName: "Me",
        content: "peer",
        delivered: true,
        at: "2026-09-02T10:03:00.000Z",
      },
    ]);
    const [agentPost, userOne, userTwo] = screen.getAllByTestId("chat-message");
    const peer = screen.getByTestId("chat-agent-message");

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

  it("renders a file attachment as an image by its MIME type when the name has no extension", () => {
    renderFeed([
      chat(
        message({
          id: "a0",
          attachments: [
            fileAttachment({
              mediaId: 9,
              fileName: "clipboard-image",
              sizeBytes: 512,
              mimeType: "image/png",
            }),
            fileAttachment({
              mediaId: 10,
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
      `/api/v1/agents/${AGENT_ID}/media/clipboard-image`
    );
    expect(image.querySelector("button")).not.toBeNull();
    expect(screen.getByTestId("chat-attachment-file").textContent).toContain(
      "archive"
    );
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
      expect.objectContaining({
        name: "shot.png",
        size: 2048,
        // Part of the lightbox identity — without it nothing opens.
        ownerAgentId: AGENT_ID,
      })
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
    // Consecutive lines sit in one cluster.
    const clusters = screen.getAllByTestId("chat-status-cluster");
    expect(clusters).toHaveLength(1);
    expect(
      clusters[0]!.querySelectorAll("[data-testid='chat-status']")
    ).toHaveLength(2);
    expect(lines[0]!.className).toContain("text-[10px]");
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
    ): ChatFeedEntry => ({
      type: "agent_message",
      id,
      direction,
      senderAgentId: direction === "in" ? "agt_2" : AGENT_ID,
      senderName: direction === "in" ? "Reviewer" : "builder",
      recipientAgentId: direction === "in" ? AGENT_ID : "agt_2",
      recipientName: direction === "in" ? "builder" : "Reviewer",
      content,
      delivered,
      at: `2026-09-02T10:00:${second}.000Z`,
    });
    renderFeed(
      [
        chat(
          message({
            id: "m1",
            text: "For you",
            createdAt: "2026-09-02T10:00:00.000Z",
          })
        ),
        side("s1", "out", "01", "Can you take a look?", null),
        side("s2", "out", "02", "Second thought"),
        side("s3", "in", "03", "Looking now"),
        chat(
          message({
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
    const posts = screen.getAllByTestId("chat-agent-message");
    expect(posts).toHaveLength(3);
    const [first, second, third] = posts as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];

    // Indented one gutter step, tinted like a peer's post either way, with
    // a muted body.
    for (const post of posts) {
      expect(post.getAttribute("data-side")).toBe("true");
      expect(post.className).toContain(SIDE_POST_INDENT);
      expect(post.className).not.toContain("px-4");
      expect(post.className).toContain(POST_TINT.peer);
      const body = Array.from(post.querySelectorAll("div")).find((el) =>
        el.className.includes(POST_BODY_MEASURE)
      );
      expect(body?.className).toContain("text-muted-foreground");
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

    // The sender's icon with the arrows overlay, on header rows only.
    expect(first.querySelector("[aria-label='Claude agent']")).not.toBeNull();
    expect(
      first.querySelector("[data-testid='chat-avatar-side-badge']")
    ).not.toBeNull();
    expect(third.querySelector("[aria-label='Codex agent']")).not.toBeNull();
    expect(
      third.querySelector("[data-testid='chat-avatar-side-badge']")
    ).not.toBeNull();

    // Same sender → same recipient groups; the reply from the other side
    // starts a new group, and the agent's post to the user right before
    // never grouped with the side conversation.
    expect(first.getAttribute("data-grouped")).toBeNull();
    expect(second.getAttribute("data-grouped")).toBe("true");
    expect(
      second.querySelector("[data-testid='chat-avatar-side-badge']")
    ).toBeNull();
    expect(third.getAttribute("data-grouped")).toBeNull();
    const userPosts = screen.getAllByTestId("chat-message");
    expect(userPosts[1]!.getAttribute("data-grouped")).toBeNull();

    // Delivery markers stay.
    expect(
      first.querySelector("[data-testid='chat-agent-message-pending']")
    ).not.toBeNull();
    expect(first.textContent).toContain("Sending");
  });

  it("renders a review card and opens the review it links to", () => {
    const onOpenReview = vi.fn();
    renderFeed(
      [
        {
          type: "review",
          id: "review:12",
          reviewId: 12,
          reviewerType: "agent",
          reviewerAgentId: "agt_reviewer",
          reviewerName: "backend-security",
          summary: "Two things to fix",
          status: "partially_resolved",
          itemCount: 3,
          resolvedCount: 1,
          at: "2026-09-02T10:00:00.000Z",
        },
      ],
      {},
      {
        onOpenReview,
        peers: peerDirectory(AGENT_ID, [
          {
            id: "agt_reviewer",
            name: "Reviewer",
            type: "codex",
            parentAgentId: AGENT_ID,
          },
        ]),
      }
    );
    const card = screen.getByTestId("chat-review");
    // Header and block name the same actor: the persona it reviewed as.
    expect(
      card.querySelector("[data-testid='chat-post-author']")?.textContent
    ).toBe("backend-security");
    expect(card.textContent).toContain("Review · backend-security");
    expect(card.textContent).toContain("1/3 resolved");
    expect(card.textContent).toContain("Open");
    // The collapsed block is a status line, not a copy of the review body.
    expect(card.textContent).not.toContain("Two things to fix");
    fireEvent.click(
      screen.getByRole("button", { name: /open review from backend-security/i })
    );
    expect(onOpenReview).toHaveBeenCalledWith(12);
  });

  it("attributes a human review to the user and says when it approved", () => {
    renderFeed([
      {
        type: "review",
        id: "review:13",
        reviewId: 13,
        reviewerType: "human",
        reviewerAgentId: null,
        reviewerName: null,
        summary: null,
        status: "resolved",
        itemCount: 0,
        resolvedCount: 0,
        at: "2026-09-02T10:00:00.000Z",
      },
    ]);
    const card = screen.getByTestId("chat-review");
    expect(
      card.querySelector("[data-testid='chat-post-author']")?.textContent
    ).toBe("You");
    expect(card.textContent).toContain("Review · Human reviewer");
    expect(card.textContent).toContain("Approved · no feedback");
    expect(card.textContent).toContain("Resolved");
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

describe("ChatFeed enter animation", () => {
  const at = (hhmm: string) => `2026-09-02T${hhmm}:00.000Z`;
  const enterOf = (el: Element) =>
    el.closest('[data-testid="chat-entry-enter"]');

  it("fades in what arrives after the first render, never what was there or paged in above", () => {
    const first = chat(
      message({ id: "a1", text: "first", createdAt: at("10:00") })
    );
    const { rerenderWith } = renderFeed([first]);
    expect(enterOf(screen.getByTestId("chat-message"))).toBeNull();

    // A new post and a new status line arrive.
    rerenderWith([
      first,
      status("s1", "working", "Running tests", at("10:01")),
      chat(message({ id: "a2", text: "second", createdAt: at("10:02") })),
    ]);
    const [one, two] = screen.getAllByTestId("chat-message");
    expect(enterOf(one!)).toBeNull();
    expect(enterOf(two!)).not.toBeNull();
    expect(enterOf(two!)!.className).toContain("animate-chat-enter");
    expect(enterOf(two!)!.className).toContain("motion-reduce:animate-none");
    expect(enterOf(screen.getByTestId("chat-status"))).not.toBeNull();

    // Still fading when the same list renders again.
    rerenderWith([
      first,
      status("s1", "working", "Running tests", at("10:01")),
      chat(message({ id: "a2", text: "second", createdAt: at("10:02") })),
    ]);
    expect(enterOf(screen.getAllByTestId("chat-message")[1]!)).not.toBeNull();

    // "Load older" puts an earlier page above: no animation for it.
    rerenderWith([
      chat(message({ id: "a0", text: "older", createdAt: at("09:00") })),
      first,
      status("s1", "working", "Running tests", at("10:01")),
      chat(message({ id: "a2", text: "second", createdAt: at("10:02") })),
    ]);
    const posts = screen.getAllByTestId("chat-message");
    expect(posts[0]!.textContent).toContain("older");
    expect(enterOf(posts[0]!)).toBeNull();
    expect(enterOf(posts[1]!)).toBeNull();
    expect(enterOf(posts[2]!)).not.toBeNull();
  });

  it("fades a post edited in place in again", () => {
    const original = message({
      id: "a1",
      text: "draft",
      createdAt: at("10:00"),
      updatedAt: at("10:00"),
    });
    const { rerenderWith } = renderFeed([chat(original)]);
    expect(enterOf(screen.getByTestId("chat-message"))).toBeNull();

    rerenderWith([
      chat({ ...original, text: "final", updatedAt: at("10:05") }),
    ]);
    const edited = screen.getByTestId("chat-message");
    expect(edited.textContent).toContain("final");
    expect(enterOf(edited)).not.toBeNull();
  });
});
