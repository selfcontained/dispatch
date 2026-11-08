// @vitest-environment jsdom
import { turnEntry } from "@/test-utils/blocks";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import {
  conversationLocation,
  ConversationLocationLink,
  ConversationReturnLink,
} from "./conversation-location-link";
vi.mock("@/hooks/use-agent-tree", () => ({
  useAgentRecord: (id: string) =>
    id === "missing"
      ? undefined
      : { id, name: id, archived: id === "archived" },
  useProjectScope: () => ({ projectId: null }),
}));
vi.mock("@/hooks/use-projects", () => ({
  useProjectScope: () => ({ projectId: null }),
}));
afterEach(cleanup);
it("uses the actual source stream with thread, message and return-home anchors", () => {
  expect(
    conversationLocation(
      { streamId: "parent", threadId: "discussion", blockId: "message" },
      false,
      "child"
    )
  ).toEqual({
    pathname: "/agents/parent",
    search: "?thread=discussion&block=message&returnAgent=child",
  });
  expect(
    conversationLocation({ streamId: "parent", threadId: null }, true).pathname
  ).toBe("/activity/history/parent");
});
it("opens task sources in the task conversation", () => {
  expect(
    conversationLocation(
      { streamId: "tsk_one", threadId: null },
      false,
      "child"
    )
  ).toEqual({
    pathname: "/tasks",
    search: "?task=tsk_one&pane=conversation&returnAgent=child",
  });
});
it("returns from the source discussion to the working agent home", () => {
  function Location() {
    const location = useLocation();
    return <output>{location.pathname}</output>;
  }
  render(
    <MemoryRouter
      initialEntries={["/agents/parent?thread=discussion&returnAgent=child"]}
    >
      <ConversationReturnLink inDrawer />
      <Location />
    </MemoryRouter>
  );
  fireEvent.click(screen.getByRole("link", { name: "Open child session" }));
  expect(screen.getByText("/agents/child")).toBeTruthy();
});

const agentPrompt = {
  source: "agent" as const,
  text: "Review this",
  senderAgentId: "sender",
  attachments: [],
};
const source = { streamId: "home", threadId: "discussion", blockId: "message" };
it.each([
  ["home", null, null, false],
  ["home", "discussion", "discussion", false],
  ["home", "discussion", null, true],
  ["other", null, null, true],
  ["tsk_one", null, null, true],
] as const)(
  "compares source %s/%s with visible thread %s",
  (streamId, sourceThread, visibleThread, visible) => {
    const turn = turnEntry({
      turn: {
        prompt: agentPrompt,
        sourceConversation: { ...source, streamId, threadId: sourceThread },
      },
    }).block.turn!;
    render(
      <MemoryRouter>
        <ConversationLocationLink
          turn={turn}
          homeId="home"
          threadId={visibleThread}
        />
      </MemoryRouter>
    );
    expect(
      screen.queryByRole("link", { name: "Source: View original message" }) !==
        null
    ).toBe(visible);
  }
);
it.each([
  [{ ...source }, "Source: View original message"],
  [
    { streamId: "home", threadId: "discussion" },
    "Source: View original discussion",
  ],
  [{ streamId: "other", threadId: null }, "Source: View original conversation"],
] as const)("labels the actual destination %#", (sourceConversation, label) => {
  const turn = turnEntry({ turn: { prompt: agentPrompt, sourceConversation } })
    .block.turn!;
  render(
    <MemoryRouter>
      <ConversationLocationLink turn={turn} homeId="home" />
    </MemoryRouter>
  );
  expect(
    screen.getByRole("link", { name: label }).getAttribute("href")
  ).toContain(sourceConversation.streamId);
});
it("omits navigation without source metadata", () => {
  render(
    <MemoryRouter>
      <ConversationLocationLink turn={turnEntry().block.turn!} homeId="home" />
    </MemoryRouter>
  );
  expect(screen.queryByRole("link")).toBeNull();
});

it("omits unavailable agents and links archived agents to history", () => {
  const { rerender } = render(
    <MemoryRouter>
      <ConversationLocationLink
        turn={
          turnEntry({
            turn: {
              prompt: agentPrompt,
              sourceConversation: { streamId: "missing", threadId: null },
            },
          }).block.turn!
        }
        homeId="home"
      />
    </MemoryRouter>
  );
  expect(screen.queryByRole("link")).toBeNull();
  rerender(
    <MemoryRouter>
      <ConversationLocationLink
        turn={
          turnEntry({
            turn: {
              prompt: agentPrompt,
              sourceConversation: {
                streamId: "archived",
                threadId: null,
                blockId: "message",
              },
            },
          }).block.turn!
        }
        homeId="home"
      />
    </MemoryRouter>
  );
  expect(screen.getByRole("link").getAttribute("href")).toBe(
    "/activity/history/archived?block=message&returnAgent=home"
  );
});

it.each([
  ["chat", undefined],
  ["launch", "sender"],
  ["system", "sender"],
  ["agent", undefined],
  ["agent", "agt_1"],
] as const)(
  "hides %s input from %s even across conversations",
  (kind, senderAgentId) => {
    const turn = turnEntry({
      turn: {
        prompt: { ...agentPrompt, source: kind, senderAgentId },
        sourceConversation: {
          streamId: "other",
          threadId: "discussion",
          blockId: "message",
        },
      },
    }).block.turn!;
    render(
      <MemoryRouter>
        <ConversationLocationLink turn={turn} homeId="home" />
      </MemoryRouter>
    );
    expect(screen.queryByRole("link")).toBeNull();
  }
);
it.each(["home", "other", "tsk_one"])(
  "hides the user's input from %s",
  (streamId) => {
    const turn = turnEntry({
      turn: {
        prompt: { source: "chat", text: "My message", attachments: [] },
        sourceConversation: {
          streamId,
          threadId: "discussion",
          blockId: "message",
        },
      },
    }).block.turn!;
    render(
      <MemoryRouter>
        <ConversationLocationLink turn={turn} homeId="home" />
      </MemoryRouter>
    );
    expect(screen.queryByRole("link")).toBeNull();
  }
);
