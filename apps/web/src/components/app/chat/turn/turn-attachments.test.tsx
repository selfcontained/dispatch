// @vitest-environment jsdom
import type {
  ChatAgentMessageEntry,
  ChatFeedEntry,
  ChatMediaEntry,
  ChatPinEntry,
  ChatTurnEntry,
} from "@dispatch/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import type { FeedContext } from "@/components/app/chat/chat-entries";
import {
  INERT_PIN_SHORTCUTS,
  PinShortcutProvider,
} from "@/components/app/chat/pin-shortcut-context";

import { foldAttachments, TurnAttachments } from "./turn-attachments";

const AGENT_ID = "agt_1";
const at = (hhmm: string): string => `2026-09-08T${hhmm}:00.000Z`;

function turn(overrides: Partial<ChatTurnEntry> = {}): ChatTurnEntry {
  return {
    type: "turn",
    id: "turn:1",
    agentId: AGENT_ID,
    at: at("10:00"),
    updatedAt: at("10:05"),
    prompt: { source: "chat", text: "go", attachments: [] },
    trace: {
      startedAt: at("10:00"),
      endedAt: at("10:05"),
      finalResult: "ok",
      steps: [],
    },
    result: { text: "done", streaming: false },
    settled: true,
    interrupted: false,
    ...overrides,
  };
}

function media(id: string, when: string): ChatMediaEntry {
  return {
    type: "media",
    id,
    mediaId: 7,
    fileName: "shot.png",
    sizeBytes: 2048,
    description: "Login page",
    at: when,
  };
}

function pin(id: string, when: string): ChatPinEntry {
  return {
    type: "pin",
    id,
    action: "created",
    pins: [{ id: "pin_1", label: "Dev URL" }],
    at: when,
  };
}

function sent(id: string, when: string): ChatAgentMessageEntry {
  return {
    type: "agent_message",
    id,
    direction: "out",
    senderAgentId: AGENT_ID,
    senderName: "builder",
    recipientAgentId: "agt_2",
    recipientName: "Reviewer",
    content: "please review",
    delivered: true,
    at: when,
  };
}

describe("foldAttachments", () => {
  it("lifts files, pins and outgoing messages into the turn that produced them", () => {
    const entries: ChatFeedEntry[] = [
      turn(),
      media("md1", at("10:01")),
      pin("pn1", at("10:02")),
      sent("am1", at("10:03")),
    ];
    const out = foldAttachments(entries);
    expect(out.entries.map((e) => e.id)).toEqual(["turn:1"]);
    expect(out.folded.get("turn:1")?.map((e) => e.id)).toEqual([
      "md1",
      "pn1",
      "am1",
    ]);
  });

  it("leaves an incoming peer message and anything after the turn ended in the feed", () => {
    const incoming: ChatAgentMessageEntry = {
      ...sent("am2", at("10:02")),
      direction: "in",
      senderAgentId: "agt_2",
      senderName: "Reviewer",
      recipientAgentId: AGENT_ID,
      recipientName: "builder",
    };
    const out = foldAttachments([turn(), incoming, media("late", at("10:06"))]);
    expect(out.entries.map((e) => e.id)).toEqual(["turn:1", "am2", "late"]);
    expect(out.folded.size).toBe(0);
  });

  it("keeps a live turn's window open", () => {
    const live = turn({
      settled: false,
      trace: { startedAt: at("10:00"), steps: [] },
      result: null,
    });
    const out = foldAttachments([live, media("md1", at("11:30"))]);
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
      media("a", at("10:01")),
      second,
      media("b", at("10:11")),
      media("between", at("10:07")),
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
    agents: [],
    onOpenMedia: () => undefined,
  } as unknown as FeedContext;

  it("renders each folded item in order with its own block", () => {
    render(
      <MemoryRouter>
        <PinShortcutProvider value={INERT_PIN_SHORTCUTS}>
          <TurnAttachments
            items={[
              media("md1", at("10:01")),
              pin("pn1", at("10:02")),
              sent("am1", at("10:03")),
            ]}
            ctx={ctx}
          />
        </PinShortcutProvider>
      </MemoryRouter>
    );
    const block = screen.getByTestId("chat-turn-attachments");
    expect(block.textContent).toContain("Login page");
    expect(block.textContent).toContain("Pinned");
    expect(block.textContent).toContain("Dev URL");
    expect(block.textContent).toContain("Sent to");
    expect(block.textContent).toContain("Reviewer");
    expect(block.textContent).toContain("please review");
    const order = Array.from(
      block.querySelectorAll(
        '[data-testid="chat-turn-media"],[data-testid="chat-turn-pin"],[data-testid="chat-turn-sent-to"]'
      )
    ).map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual([
      "chat-turn-media",
      "chat-turn-pin",
      "chat-turn-sent-to",
    ]);
  });

  it("renders nothing for an empty list", () => {
    const { container } = render(<TurnAttachments items={[]} ctx={ctx} />);
    expect(container.innerHTML).toBe("");
  });
});
