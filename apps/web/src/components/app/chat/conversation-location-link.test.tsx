// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import {
  conversationLocation,
  ConversationReturnLink,
} from "./conversation-location-link";
vi.mock("@/hooks/use-agent-tree", () => ({
  useAgentRecord: (id: string) => ({ id, name: id, archived: false }),
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
