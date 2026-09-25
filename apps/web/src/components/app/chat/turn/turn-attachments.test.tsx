// @vitest-environment jsdom
import type {
  ChatTurnEntry,
  StreamBlockEntry,
  StreamEntry,
} from "@dispatch/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FeedContext } from "@/components/app/chat/chat-entries";
import { block, blockEntry, FILE_BODY, turnEntry } from "@/test-utils/blocks";

import {
  foldAttachments,
  TurnAttachments,
  turnWindow,
} from "./turn-attachments";

const AGENT_ID = "agt_1";
const at = (hhmm: string): string => `2026-09-08T${hhmm}:00.000Z`;

/**
 * A settled turn's block, run by `agentId` from 10:00 to 10:05 unless the
 * turn says otherwise. The block's id is the turn's id on the feed.
 */
function turn(overrides: Partial<ChatTurnEntry> = {}): StreamBlockEntry {
  const id = overrides.id ?? "turn:1";
  const agentId = overrides.agentId ?? AGENT_ID;
  return turnEntry({
    id,
    author: { kind: "agent", agentId },
    createdAt: overrides.at ?? at("10:00"),
    text: "done",
    turn: {
      updatedAt: at("10:05"),
      trace: {
        startedAt: at("10:00"),
        endedAt: at("10:05"),
        finalResult: "ok",
        steps: [],
      },
      ...overrides,
    },
  });
}

function sharedFile(id: string, when: string): StreamBlockEntry {
  return blockEntry(
    block({
      id,
      text: "Login page",
      body: FILE_BODY,
      attachments: [
        { type: "file", fileId: 7, fileName: "shot.png", sizeBytes: 2048 },
      ],
      createdAt: when,
    })
  );
}

/** A post from one agent to another: a block with `toAgentId` set. */
function sent(
  id: string,
  when: string,
  from = AGENT_ID,
  to = "agt_2"
): StreamBlockEntry {
  return blockEntry(
    block({
      id,
      author: { kind: "agent", agentId: from },
      toAgentId: to,
      // A parent's post to a child threads under the child's launch post.
      threadId: "launch_2",
      replyTo: "launch_2",
      text: "please review",
      delivered: true,
      createdAt: when,
    })
  );
}

describe("turnWindow", () => {
  it("runs from the turn's start to its end, open-ended while it runs", () => {
    expect(turnWindow(turn().block.turn!)).toEqual({
      start: Date.parse(at("10:00")),
      end: Date.parse(at("10:05")),
    });
    // A turn cut by a restart settled without an end: its last update is it.
    expect(
      turnWindow(
        turn({ trace: { startedAt: at("10:00"), steps: [] } }).block.turn!
      ).end
    ).toBe(Date.parse(at("10:05")));
    expect(
      turnWindow(
        turn({
          settled: false,
          trace: { startedAt: at("10:00"), steps: [] },
          result: null,
        }).block.turn!
      ).end
    ).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("foldAttachments", () => {
  it("lifts files and posts to other agents into the turn that produced them", () => {
    const entries: StreamEntry[] = [
      turn(),
      sharedFile("md1", at("10:01")),
      sent("am1", at("10:03")),
    ];
    const out = foldAttachments(entries, AGENT_ID);
    expect(out.entries.map((e) => e.id)).toEqual(["turn:1"]);
    expect(out.folded.get("turn:1")?.map((e) => e.id)).toEqual(["md1", "am1"]);
  });

  it("folds a plain post with attachments, and leaves a plain post without them", () => {
    const withPr = blockEntry(
      block({
        id: "pr",
        text: "Opened the PR",
        attachments: [{ type: "pr", url: "https://github.com/o/r/pull/1" }],
        createdAt: at("10:02"),
      })
    );
    const plain = blockEntry(
      block({ id: "note", text: "Heads up", createdAt: at("10:03") })
    );
    const out = foldAttachments([turn(), withPr, plain], AGENT_ID);
    expect(out.entries.map((e) => e.id)).toEqual(["turn:1", "note"]);
    expect(out.folded.get("turn:1")?.map((e) => e.id)).toEqual(["pr"]);
  });

  it("leaves another agent's post to this one, and anything after the turn ended, in the feed", () => {
    const incoming = sent("am2", at("10:02"), "agt_2", AGENT_ID);
    const out = foldAttachments(
      [turn(), incoming, sharedFile("late", at("10:06"))],
      AGENT_ID
    );
    expect(out.entries.map((e) => e.id)).toEqual(["turn:1", "am2", "late"]);
    expect(out.folded.size).toBe(0);
  });

  it("folds only the page agent's rows, under its own turns, when a child's turn interleaves", () => {
    const childTurn = turn({
      id: "turn:child",
      agentId: "agt_2",
      at: at("10:01"),
      updatedAt: at("10:04"),
      trace: {
        startedAt: at("10:01"),
        endedAt: at("10:04"),
        finalResult: "ok",
        steps: [],
      },
    });
    const childFile = blockEntry(
      block({
        id: "child-file",
        author: { kind: "agent", agentId: "agt_2" },
        text: "Report",
        body: FILE_BODY,
        attachments: [
          { type: "file", fileId: 8, fileName: "r.md", sizeBytes: 10 },
        ],
        createdAt: at("10:02"),
      })
    );
    const out = foldAttachments(
      [
        turn(),
        childTurn,
        childFile,
        // The child's reply to its parent: a post of its own in the feed.
        sent("reply", at("10:03"), "agt_2", AGENT_ID),
        sharedFile("md1", at("10:03")),
        sharedFile("md2", at("10:04")),
      ],
      AGENT_ID
    );
    // The child's file and its reply stay posts by the child; the child's
    // turn between does not close the parent's window.
    expect(out.entries.map((e) => e.id)).toEqual([
      "turn:1",
      "turn:child",
      "child-file",
      "reply",
    ]);
    expect(out.folded.get("turn:1")?.map((e) => e.id)).toEqual(["md1", "md2"]);
    expect(out.folded.has("turn:child")).toBe(false);
  });

  it("keeps a live turn's window open", () => {
    const live = turn({
      settled: false,
      trace: { startedAt: at("10:00"), steps: [] },
      result: null,
    });
    const out = foldAttachments([live, sharedFile("md1", at("11:30"))]);
    expect(out.entries.map((e) => e.id)).toEqual(["turn:1"]);
    expect(out.folded.get("turn:1")?.map((e) => e.id)).toEqual(["md1"]);
  });

  it("folds into the nearest turn above, never an earlier one", () => {
    const first = turn({ id: "turn:1" });
    const second = turn({
      id: "turn:2",
      at: at("10:10"),
      updatedAt: at("10:12"),
      trace: {
        startedAt: at("10:10"),
        endedAt: at("10:12"),
        finalResult: "ok",
        steps: [],
      },
    });
    const out = foldAttachments([
      first,
      sharedFile("a", at("10:01")),
      second,
      sharedFile("b", at("10:11")),
      sharedFile("between", at("10:07")),
    ]);
    expect(out.entries.map((e) => e.id)).toEqual([
      "turn:1",
      "turn:2",
      "between",
    ]);
    expect(out.folded.get("turn:1")?.map((e) => e.id)).toEqual(["a"]);
    expect(out.folded.get("turn:2")?.map((e) => e.id)).toEqual(["b"]);
  });
});

describe("TurnAttachments", () => {
  afterEach(cleanup);

  const ctx: FeedContext = {
    agentId: AGENT_ID,
    agentName: "builder",
    agentType: "claude",
    peers: {
      agt_2: { name: "Reviewer", agentType: "codex", relation: "child" },
    },
    onOpenFile: () => undefined,
  };

  it("renders each folded item in order with its own block", () => {
    render(
      <MemoryRouter>
        <TurnAttachments
          items={[sharedFile("md1", at("10:01")), sent("am1", at("10:03"))]}
          ctx={ctx}
        />
      </MemoryRouter>
    );
    const block = screen.getByTestId("chat-turn-attachments");
    expect(block.textContent).toContain("Login page");
    expect(block.textContent).toContain("Sent to");
    expect(block.textContent).toContain("Reviewer");
    expect(block.textContent).toContain("please review");
    const order = Array.from(
      block.querySelectorAll(
        '[data-testid="chat-turn-block"],[data-testid="chat-turn-sent-to"]'
      )
    ).map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual(["chat-turn-block", "chat-turn-sent-to"]);
  });

  it("says a post held behind the recipient's turn is queued, not sending", () => {
    const held = blockEntry(
      block({
        id: "held1",
        author: { kind: "agent", agentId: AGENT_ID },
        toAgentId: "agt_2",
        text: "please review",
        delivered: null,
        delivery: [{ agentId: "agt_2", state: "held" }],
        createdAt: at("10:03"),
      })
    );
    render(
      <MemoryRouter>
        <TurnAttachments items={[held]} ctx={ctx} />
      </MemoryRouter>
    );
    const row = screen.getByTestId("chat-turn-sent-to");
    expect(row.textContent).toContain("Queued until the turn ends");
    expect(row.textContent).not.toContain("Sending");
  });

  it("folds a sent post to one line naming the recipient and its state, and opens to the whole post", () => {
    const post = blockEntry(
      block({
        id: "long1",
        author: { kind: "agent", agentId: AGENT_ID },
        toAgentId: "agt_2",
        text: "Please review the diff.\n\nFocus on the retry path in chat-pane.",
        delivery: [{ agentId: "agt_2", state: "pending" }],
        createdAt: at("10:03"),
      })
    );
    render(
      <MemoryRouter>
        <TurnAttachments items={[post]} ctx={ctx} />
      </MemoryRouter>
    );
    const row = screen.getByTestId("chat-turn-sent-to");
    const toggle = screen.getByTestId("chat-turn-sent-to-toggle");
    const body = screen.getByTestId("chat-turn-sent-to-body");
    expect(row.getAttribute("data-open")).toBe("false");
    expect(toggle.textContent).toContain("Reviewer");
    expect(toggle.textContent).toContain("Please review the diff.");
    expect(toggle.textContent).not.toContain("Focus on the retry path");
    expect(row.textContent).toContain("Sending");
    expect(body.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(toggle);
    expect(row.getAttribute("data-open")).toBe("true");
    expect(body.getAttribute("aria-hidden")).toBe("false");
    expect(body.textContent).toContain("Focus on the retry path in chat-pane.");
  });

  it("offers Send again on a failed sent post, through the main row's retry", () => {
    const onRetryDelivery = vi.fn();
    const failed = blockEntry(
      block({
        id: "failed1",
        author: { kind: "agent", agentId: AGENT_ID },
        toAgentId: "agt_2",
        text: "please review",
        delivered: false,
        delivery: [{ agentId: "agt_2", state: "failed" }],
        createdAt: at("10:03"),
      })
    );
    render(
      <MemoryRouter>
        <TurnAttachments items={[failed]} ctx={{ ...ctx, onRetryDelivery }} />
      </MemoryRouter>
    );
    const row = screen.getByTestId("chat-turn-sent-to");
    expect(row.textContent).toContain("Not delivered");
    fireEvent.click(screen.getByTestId("chat-delivery-retry"));
    expect(onRetryDelivery).toHaveBeenCalledWith("failed1");
    // Sending again does not open the fold.
    expect(row.getAttribute("data-open")).toBe("false");
  });

  it("renders nothing for an empty list", () => {
    const { container } = render(<TurnAttachments items={[]} ctx={ctx} />);
    expect(container.innerHTML).toBe("");
  });
});
