// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { block, questionBody } from "@/test-utils/blocks";
import { PendingInputsButton } from "./pending-inputs-button";

const { jump, inputs, scopes } = vi.hoisted(() => ({
  jump: vi.fn(),
  scopes: [] as string[],
  inputs: [] as ReturnType<typeof block>[],
}));
vi.mock("@/hooks/use-block-jump", () => ({ useJumpToTurn: () => jump }));
vi.mock("@/hooks/use-stream", () => ({
  useStreamFeedSelect: (
    id: string,
    select: (entries: never[], across: { openInputs: typeof inputs }) => unknown
  ) => {
    scopes.push(id);
    return { data: select([], { openInputs: inputs }) };
  },
}));
afterEach(() => {
  cleanup();
  inputs.length = 0;
  scopes.length = 0;
  jump.mockClear();
});

it("reads the selected home and cycles all its authorized pending inputs", () => {
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
  const view = (id: string) => (
    <QueryClientProvider client={client}>
      <PendingInputsButton agentId={id} />
    </QueryClientProvider>
  );
  const rendered = render(view("child"));
  expect(screen.getByTestId("chat-pending-inputs").textContent).toContain("3");
  expect(scopes.at(-1)).toBe("child");
  fireEvent.click(screen.getByTestId("chat-pending-inputs"));
  fireEvent.click(screen.getByTestId("chat-pending-inputs"));
  expect(jump).toHaveBeenLastCalledWith(
    "child",
    { blockId: "grandchild-ask", threadId: null },
    "smooth"
  );
  rendered.rerender(view("child"));
  expect(screen.getByTestId("chat-pending-inputs").textContent).toContain("3");
  rendered.rerender(view("root"));
  expect(scopes.at(-1)).toBe("root");
  expect(screen.getByTestId("chat-pending-inputs").textContent).toContain("3");
});
