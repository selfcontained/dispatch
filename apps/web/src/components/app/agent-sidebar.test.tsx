// @vitest-environment jsdom
import React from "react";
import { Provider, createStore } from "jotai";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "./types";
import type { AgentCardProps } from "./agent-card";
import { AgentListContent, type AgentListContentProps } from "./agent-sidebar";
import { agentSidebarOrderAtom, agentSidebarPinsAtom } from "@/lib/store";

vi.mock("./project-switcher", () => ({
  ProjectSwitcher: () => <span>Project scope</span>,
}));
// Keep the sidebar's actual lineage projection, atoms, keyboard and native drag
// wiring; the real card/action side effects are covered in agent-card.test.tsx.
vi.mock("@/components/app/agent-card", () => ({
  AgentCard: ({
    agent,
    childAgents,
    isPinned,
    onTogglePin,
    containerProps,
  }: AgentCardProps) => {
    const { nativeDragHandlers, ...props } = containerProps ?? {};
    const ref = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
      const node = ref.current!;
      const handlers = Object.entries(nativeDragHandlers ?? {});
      handlers.forEach(([event, handler]) =>
        node.addEventListener(event, handler as EventListener)
      );
      return () =>
        handlers.forEach(([event, handler]) =>
          node.removeEventListener(event, handler as EventListener)
        );
    }, [nativeDragHandlers]);
    return (
      <div ref={ref} {...props} data-testid={`card-${agent.id}`}>
        <button
          data-agent-control="true"
          aria-pressed={isPinned}
          onClick={() => onTogglePin?.(agent.id)}
        >
          {agent.id}
        </button>
        {childAgents.map((child) => (
          <span key={child.id} data-testid={`nested-${child.id}`}>
            {child.id}
          </span>
        ))}
      </div>
    );
  },
}));

const make = (id: string, parentAgentId?: string): Agent =>
  ({ id, name: id, parentAgentId }) as Agent;
const agents = [make("a"), make("b"), make("c"), make("d"), make("child", "b")];
function propsFor(visible: Agent[]): AgentListContentProps {
  return {
    agents: visible,
    selectedAgentId: "a",
    expandedAgentId: "b",
    overflowAgentId: null,
    enabledAgentTypes: ["codex"],
    enabledIdes: [],
    lastUsedAgentType: null,
    onOpenCreateDialog: vi.fn(),
    setOverflowAgentId: vi.fn(),
    setDeleteTarget: vi.fn(),
    setDeleteConfirmOpen: vi.fn(),
    setStopTarget: vi.fn(),
    setStopConfirmOpen: vi.fn(),
    agentVisualState: () => "idle",
    borderForAgentState: () => "",
    toggleAgentDetails: vi.fn(),
    isFullAccessEnabled: () => false,
    closeAgent: vi.fn(),
    openAgent: vi.fn(),
    startAgent: vi.fn(),
    onRequestClose: vi.fn(),
    closeOnSessionAction: true,
  };
}
function setup(pins: string[] = []) {
  const store = createStore();
  store.set(agentSidebarOrderAtom, ["a", "b", "c", "d"]);
  store.set(agentSidebarPinsAtom, pins);
  const props = propsFor(agents);
  const node = (visible: Agent[]) => (
    <Provider store={store}>
      <AgentListContent {...props} agents={visible} />
    </Provider>
  );
  const view = render(node(agents));
  return {
    store,
    props,
    rerender: (visible: Agent[]) => view.rerender(node(visible)),
  };
}
function order() {
  return screen
    .getAllByTestId(/^card-/)
    .map((el) => el.dataset.testid!.replace("card-", ""));
}
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("sidebar pin integration", () => {
  it("keeps nested children with cards and retains hidden pins through scope changes", () => {
    const { store, props, rerender } = setup(["stale", "child", ""]);
    fireEvent.click(screen.getByRole("button", { name: "c" }));
    fireEvent.click(screen.getByRole("button", { name: "b" }));
    expect(order()).toEqual(["b", "c", "a", "d"]);
    expect(
      screen.getByTestId("nested-child").closest('[data-testid="card-b"]')
    ).toBeTruthy();
    expect(screen.queryByTestId("card-child")).toBeNull();
    expect(store.get(agentSidebarOrderAtom)).toEqual(["a", "b", "c", "d"]);
    rerender(
      agents.filter((agent) => agent.id === "b" || agent.id === "child")
    );
    expect(order()).toEqual(["b"]);
    fireEvent.click(screen.getByRole("button", { name: "b" }));
    expect(store.get(agentSidebarPinsAtom)).toContain("c");
    rerender(agents);
    expect(order()).toEqual(["c", "a", "b", "d"]);
    expect(props.openAgent).not.toHaveBeenCalled();
    expect(props.toggleAgentDetails).not.toHaveBeenCalled();
    expect(props.onRequestClose).not.toHaveBeenCalled();
  });

  it("keyboard reorders visible group members and preserves hidden normal-order slots", () => {
    const { store, rerender } = setup(["b", "d"]);
    fireEvent.keyDown(screen.getByTestId("card-a"), {
      altKey: true,
      key: "ArrowUp",
    });
    expect(store.get(agentSidebarOrderAtom)).toEqual(["a", "b", "c", "d"]);
    fireEvent.keyDown(screen.getByTestId("card-c"), {
      altKey: true,
      key: "ArrowUp",
    });
    expect(order()).toEqual(["b", "d", "c", "a"]);
    expect(store.get(agentSidebarOrderAtom)).toEqual(["c", "b", "a", "d"]);
    rerender(agents.filter((agent) => agent.id === "b" || agent.id === "d"));
    fireEvent.keyDown(screen.getByTestId("card-d"), {
      altKey: true,
      key: "ArrowUp",
    });
    expect(store.get(agentSidebarOrderAtom)).toEqual(["c", "d", "a", "b"]);
    rerender(agents);
    expect(order()).toEqual(["d", "b", "c", "a"]);
    expect(
      screen.getByText(/moved up to position 1 of 2 in the pinned group/)
    ).toBeTruthy();
  });

  it("native drag rejects other-group targets and moves only same-group slots", () => {
    const { store } = setup(["b", "d"]);
    let payload = "";
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "none",
      setData: (_type: string, value: string) => {
        payload = value;
      },
      getData: () => payload,
    };
    fireEvent.dragStart(screen.getByTestId("card-d"), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("card-a"), {
      dataTransfer,
      clientY: 1,
    });
    expect(dataTransfer.dropEffect).toBe("none");
    fireEvent.drop(screen.getByTestId("card-a"), { dataTransfer, clientY: 1 });
    expect(store.get(agentSidebarOrderAtom)).toEqual(["a", "b", "c", "d"]);
    fireEvent.dragStart(screen.getByTestId("card-d"), { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("card-b"), {
      dataTransfer,
      clientY: 0,
    });
    expect(dataTransfer.dropEffect).toBe("move");
    fireEvent.drop(screen.getByTestId("card-b"), { dataTransfer, clientY: 0 });
    expect(order()).toEqual(["d", "b", "a", "c"]);
    expect(store.get(agentSidebarOrderAtom)).toEqual(["a", "d", "c", "b"]);
  });
});
