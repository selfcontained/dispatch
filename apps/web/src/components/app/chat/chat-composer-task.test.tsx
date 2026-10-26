// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatComposer } from "./chat-composer";
vi.mock("./composer-input", () => import("@/test-utils/composer-input"));
vi.mock("./share-task-picker", () => ({
  ShareTaskPicker: ({
    onShare,
    disabled,
  }: {
    onShare: (id: string) => Promise<void>;
    disabled: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void onShare("tsk_012345abcdef")}
    >
      Share task
    </button>
  ),
}));
afterEach(cleanup);
const conversation = { streamId: "root", threadId: null };
const agent = {
  id: "a",
  activity: "working" as const,
  currentTurn: { blockId: "turn-a", ...conversation },
  inputState: {
    active: true,
    interruptSupported: true,
    steeringSupported: true,
    conversation,
  },
};
it("shares a task with the selected Queue timing while preserving the draft", () => {
  const onSend = vi.fn(async () => {});
  render(
    <ChatComposer
      agentId={null}
      disabledReason={null}
      onSend={onSend}
      canQueue
      conversation={conversation}
      defaultRecipients={[{ id: "a", name: "Builder" }]}
      deliveryAgents={[agent]}
    />
  );
  const input = screen.getByTestId(
    "chat-composer-input"
  ) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Message timing: Now" }));
  fireEvent.click(screen.getByRole("button", { name: "Queue for next turn" }));
  fireEvent.click(screen.getByRole("button", { name: "Share task" }));
  expect(onSend).toHaveBeenCalledWith("", [], {
    task: { id: "tsk_012345abcdef" },
    delivery: "queue",
  });
  expect(input.value).toBe("Keep this draft");
});
it("blocks task sharing when the selected Interrupt becomes unavailable", () => {
  const onSend = vi.fn(async () => {});
  const props = {
    agentId: null,
    disabledReason: null,
    onSend,
    canQueue: true,
    conversation,
    defaultRecipients: [{ id: "a", name: "Builder" }],
  };
  const { rerender } = render(
    <ChatComposer {...props} deliveryAgents={[agent]} />
  );
  fireEvent.click(screen.getByRole("button", { name: "Message timing: Now" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Interrupt current work" })
  );
  rerender(
    <ChatComposer
      {...props}
      deliveryAgents={[
        {
          ...agent,
          inputState: { ...agent.inputState, interruptSupported: false },
        },
      ]}
    />
  );
  expect(
    (screen.getByRole("button", { name: "Share task" }) as HTMLButtonElement)
      .disabled
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Share task" }));
  expect(onSend).not.toHaveBeenCalled();
});
