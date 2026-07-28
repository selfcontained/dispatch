// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentMessage } from "@/hooks/use-agent-messages";

import { HistoryMessages } from "./agent-history-messages";

// Thread groups collapse through AnimatePresence; strip the animation layer
// so mount/unmount happens synchronously in jsdom.
vi.mock("framer-motion", async (importOriginal) => {
  const { createFramerMotionMock } =
    await import("@/test-utils/framer-motion-mock");
  return createFramerMotionMock(importOriginal);
});

const SELF_ID = "agt_self";

function makeMessage(
  id: string,
  overrides: Partial<AgentMessage> = {}
): AgentMessage {
  return {
    id,
    senderAgentId: SELF_ID,
    recipientAgentId: "agt_one",
    senderName: "self-agent",
    recipientName: "Helper One",
    content: `content-${id}`,
    delivered: true,
    readAt: "2026-07-20T10:00:05.000Z",
    createdAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  };
}

function bubbleFor(content: string): HTMLElement {
  const bubble = screen
    .getByText(content)
    .closest('[data-testid="message-item"]');
  if (!(bubble instanceof HTMLElement))
    throw new Error(`No message bubble containing ${content}`);
  return bubble;
}

afterEach(cleanup);

describe("HistoryMessages", () => {
  it("groups messages into one thread per counterpart with message counts", () => {
    render(
      <HistoryMessages
        agentId={SELF_ID}
        messages={[
          makeMessage("m1", { content: "ping one" }),
          makeMessage("m2", {
            senderAgentId: "agt_one",
            recipientAgentId: SELF_ID,
            senderName: "Helper One",
            recipientName: "self-agent",
            content: "pong one",
          }),
          makeMessage("m3", {
            senderAgentId: "agt_two",
            recipientAgentId: SELF_ID,
            senderName: "Helper Two",
            recipientName: "self-agent",
            content: "hello two",
          }),
        ]}
      />
    );

    // One header per counterpart — the sent and received Helper One messages
    // must land in the same thread.
    const one = screen.getByText("Helper One").closest("button")!;
    const two = screen.getByText("Helper Two").closest("button")!;
    expect(one.textContent).toContain("2");
    expect(two.textContent).toContain("1");
    expect(screen.getAllByTestId("message-item")).toHaveLength(3);
  });

  it("marks own messages as sent and counterpart messages as received", () => {
    render(
      <HistoryMessages
        agentId={SELF_ID}
        messages={[
          makeMessage("m1", { content: "ping one" }),
          makeMessage("m2", {
            senderAgentId: "agt_one",
            recipientAgentId: SELF_ID,
            senderName: "Helper One",
            recipientName: "self-agent",
            content: "pong one",
          }),
        ]}
      />
    );

    // MessageBubble styles sent messages with the primary background and
    // received ones with the muted background — the isSent seam DetailTabs
    // relies on for direction.
    expect(bubbleFor("ping one").className).toContain("bg-primary");
    expect(bubbleFor("pong one").className).toContain("bg-muted");
  });

  it("collapses and re-expands a thread without touching its sibling", () => {
    render(
      <HistoryMessages
        agentId={SELF_ID}
        messages={[
          makeMessage("m1", { content: "ping one" }),
          makeMessage("m3", {
            senderAgentId: "agt_two",
            recipientAgentId: SELF_ID,
            senderName: "Helper Two",
            recipientName: "self-agent",
            content: "hello two",
          }),
        ]}
      />
    );

    const header = screen.getByText("Helper One").closest("button")!;

    fireEvent.click(header);
    expect(screen.queryByText("ping one")).toBeNull();
    // Sibling thread state is independent.
    expect(screen.getByText("hello two")).toBeTruthy();

    fireEvent.click(header);
    expect(screen.getByText("ping one")).toBeTruthy();
  });
});
