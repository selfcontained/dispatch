// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import { StopTurnButton } from "./stop-turn-button";

vi.mock("@/lib/api", () => ({ api: vi.fn(async () => ({})) }));
afterEach(cleanup);

const agent = {
  id: "agt_1",
  name: "First agent",
  status: "running",
  currentTurn: { blockId: "turn_1", threadId: null },
} as Agent;
const other = {
  ...agent,
  id: "agt_2",
  name: "Second agent",
  currentTurn: { blockId: "turn_2", threadId: null },
};

function setup() {
  const client = new QueryClient();
  const onError = vi.fn();
  const view = (agents: Agent[]) => (
    <QueryClientProvider client={client}>
      <form>
        <input data-testid="chat-composer-input" />
        <StopTurnButton
          agents={agents}
          selectedAgentId={agent.id}
          onError={onError}
        />
      </form>
    </QueryClientProvider>
  );
  const rendered = render(view([agent, other]));
  const trigger = screen.getByTestId("chat-stop-turn") as HTMLButtonElement;
  return {
    trigger,
    rerender: (agents: Agent[]) => rendered.rerender(view(agents)),
  };
}

async function openMenu(trigger: HTMLButtonElement) {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  return screen.findByTestId("chat-stop-agent-agt_2");
}

describe("StopTurnButton focus", () => {
  it("returns focus to the same trigger when the menu collapses to one turn", async () => {
    const { trigger, rerender } = setup();
    const item = await openMenu(trigger);
    item.focus();
    expect(document.activeElement).toBe(item);

    rerender([agent]);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute("aria-haspopup")).toBeNull();

    rerender([agent, other]);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("chat-stop-agent-agt_2")).toBeNull();
  });

  it("moves focus to the composer when the menu collapses to no turns", async () => {
    const { trigger, rerender } = setup();
    const item = await openMenu(trigger);
    item.focus();
    expect(document.activeElement).toBe(item);

    rerender([]);
    const input = screen.getByTestId("chat-composer-input");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(trigger.disabled).toBe(true);
  });
});
