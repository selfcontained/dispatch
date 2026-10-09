// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { block, questionBody } from "@/test-utils/blocks";
import { PendingInputsButton } from "./pending-inputs-button";

const { jump, inputs } = vi.hoisted(() => ({
  jump: vi.fn(),
  inputs: [] as ReturnType<typeof block>[],
}));
vi.mock("@/hooks/use-block-jump", () => ({ useJumpToTurn: () => jump }));
vi.mock("@/hooks/use-stream", () => ({
  useStreamFeedSelect: (
    _id: string,
    select: (entries: never[], across: { openInputs: typeof inputs }) => unknown
  ) => ({ data: select([], { openInputs: inputs }) }),
}));
afterEach(() => {
  cleanup();
  inputs.length = 0;
  jump.mockClear();
});

it("includes visible grandchildren, cycles them, and keeps root inputs when children are hidden", () => {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  client.setQueryData(
    ["agents"],
    [
      { id: "root", parentAgentId: null },
      { id: "child", parentAgentId: "root" },
      { id: "grandchild", parentAgentId: "child" },
      { id: "sibling", parentAgentId: "root" },
    ]
  );
  inputs.push(
    ...["child", "grandchild", "sibling"].map((id) =>
      block({
        id: id + "-ask",
        streamId: "root",
        author: { kind: "agent", agentId: id },
        body: questionBody([{ label: "Yes" }]),
      })
    )
  );
  inputs.push(
    block({
      id: "failed-parent-request",
      streamId: "root",
      toAgentId: "root",
      author: { kind: "agent", agentId: "child" },
      delivered: false,
      body: {
        kind: "question",
        data: { options: [{ label: "Yes" }], parentHandled: true },
        state: {},
      },
    })
  );
  const view = (id: string, children: boolean) => (
    <QueryClientProvider client={client}>
      <PendingInputsButton agentId={id} showChildAgents={children} />
    </QueryClientProvider>
  );
  const rendered = render(view("child", true));
  expect(screen.getByTestId("chat-pending-inputs").textContent).toContain("2");
  fireEvent.click(screen.getByTestId("chat-pending-inputs"));
  fireEvent.click(screen.getByTestId("chat-pending-inputs"));
  expect(jump).toHaveBeenLastCalledWith(
    "child",
    { blockId: "grandchild-ask", threadId: null },
    "smooth"
  );
  rendered.rerender(view("child", false));
  expect(screen.getByTestId("chat-pending-inputs").textContent).toContain("1");
  rendered.rerender(view("root", false));
  expect(screen.getByTestId("chat-pending-inputs").textContent).toContain("3");
});
