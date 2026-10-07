// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { block, blockEntry } from "@/test-utils/blocks";
import { RequestContext } from "./request-context";

const user = (id: string) =>
  blockEntry(block({ id, authorKind: "user", text: id }));
const agent = (id: string) => blockEntry(block({ id, text: id }));
const defaults = {
  attachmentContext: {
    agentId: "test",
    agentName: "Test",
    onOpenFile: vi.fn(),
  },
  hasOlder: false,
  loading: false,
  error: null,
  loadOlder: vi.fn(),
  onJump: vi.fn(),
};

afterEach(cleanup);

describe("request context", () => {
  it("skips launch cards an agent wrote for its children", () => {
    const launch = (id: string, launchedByAgentId?: string) =>
      blockEntry(
        block({
          id,
          authorKind: "user",
          text: id,
          body: { kind: "launch", data: null, state: null },
          ...(launchedByAgentId ? { launchedByAgentId } : {}),
        })
      );
    render(
      <RequestContext
        {...defaults}
        entries={[
          launch("My launch"),
          user("My request"),
          launch("Child briefing", "agt_1"),
        ]}
      />
    );
    expect(screen.getByTestId("request-context-text").textContent).toContain(
      "My request"
    );
    fireEvent.click(screen.getByLabelText("Previous message"));
    expect(screen.getByTestId("request-context-text").textContent).toContain(
      "My launch"
    );
  });

  it("keeps the user's request across agent traffic and follows new user messages", () => {
    const { rerender } = render(
      <RequestContext
        {...defaults}
        entries={[user("First request"), agent("Review complete")]}
      />
    );
    expect(screen.getByTestId("request-context-text").textContent).toContain(
      "First request"
    );
    rerender(
      <RequestContext
        {...defaults}
        entries={[
          user("First request"),
          agent("Review complete"),
          user("Second request"),
        ]}
      />
    );
    expect(screen.getByTestId("request-context-text").textContent).toContain(
      "Second request"
    );
    fireEvent.click(screen.getByLabelText("Previous message"));
    rerender(
      <RequestContext
        {...defaults}
        entries={[
          user("First request"),
          user("Second request"),
          agent("More activity"),
        ]}
      />
    );
    expect(screen.getByTestId("request-context-text").textContent).toContain(
      "First request"
    );
    fireEvent.click(screen.getByLabelText("Next message"));
    rerender(
      <RequestContext
        {...defaults}
        entries={[
          user("First request"),
          user("Second request"),
          user("Third request"),
        ]}
      />
    );
    expect(screen.getByTestId("request-context-text").textContent).toContain(
      "Third request"
    );
  });

  it("only searches older pages on request, without eagerly changing the stream", async () => {
    const loadOlder = vi.fn();
    const { rerender } = render(
      <RequestContext
        {...defaults}
        hasOlder
        loadOlder={loadOlder}
        entries={[agent("Recent activity")]}
      />
    );
    expect(loadOlder).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Find your last message" })
    );
    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(1));
    rerender(
      <RequestContext
        {...defaults}
        hasOlder
        loading
        loadOlder={loadOlder}
        entries={[agent("Recent activity")]}
      />
    );
    expect(loadOlder).toHaveBeenCalledTimes(1);
    rerender(
      <RequestContext
        {...defaults}
        loadOlder={loadOlder}
        entries={[user("Original request"), agent("Recent activity")]}
      />
    );
    expect(screen.getByTestId("request-context-text").textContent).toContain(
      "Original request"
    );
  });

  it("selects the previous request after loading through a page of agent messages", async () => {
    const loadOlder = vi.fn();
    const { rerender } = render(
      <RequestContext
        {...defaults}
        hasOlder
        loadOlder={loadOlder}
        entries={[user("Latest request")]}
      />
    );
    fireEvent.click(screen.getByLabelText("Previous message"));
    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(1));
    rerender(
      <RequestContext
        {...defaults}
        hasOlder
        loadOlder={loadOlder}
        entries={[agent("Older agent traffic"), user("Latest request")]}
      />
    );
    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(2));
    rerender(
      <RequestContext
        {...defaults}
        loadOlder={loadOlder}
        entries={[
          user("Original request"),
          agent("Older agent traffic"),
          user("Latest request"),
        ]}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId("request-context-text").textContent).toContain(
        "Original request"
      )
    );
    expect(
      screen.getByLabelText("Previous message").hasAttribute("disabled")
    ).toBe(true);
  });

  it("stops fetching on failure and allows retry", async () => {
    const loadOlder = vi.fn();
    const { rerender } = render(
      <RequestContext
        {...defaults}
        hasOlder
        loadOlder={loadOlder}
        entries={[user("Latest request")]}
      />
    );
    fireEvent.click(screen.getByLabelText("Previous message"));
    await waitFor(() => expect(loadOlder).toHaveBeenCalledTimes(1));
    rerender(
      <RequestContext
        {...defaults}
        hasOlder
        error={new Error("offline")}
        loadOlder={loadOlder}
        entries={[user("Latest request")]}
      />
    );
    expect(loadOlder).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Previous message"));
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });
});
