// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalLazyBoundary } from "./terminal-lazy-boundary";

const mounted = vi.hoisted(() => vi.fn());
vi.mock("./terminal-panel", () => ({
  default: ({ agentId, active }: { agentId: string; active: boolean }) => {
    mounted(agentId, active);
    return (
      <div data-testid="terminal-panel">{active ? "visible" : "hidden"}</div>
    );
  },
}));
afterEach(() => {
  cleanup();
  mounted.mockClear();
});

it("does not mount a persisted Terminal selection while the sidebar is closed", async () => {
  const { rerender } = render(
    <TerminalLazyBoundary agentId="agent" active={false} />
  );
  expect(mounted).not.toHaveBeenCalled();
  rerender(<TerminalLazyBoundary agentId="agent" active />);
  expect((await screen.findByTestId("terminal-panel")).textContent).toBe(
    "visible"
  );
  rerender(<TerminalLazyBoundary agentId="agent" active={false} />);
  expect(screen.getByTestId("terminal-panel").textContent).toBe("hidden");
});

it("defers a newly selected agent's panel until visible", async () => {
  const { rerender } = render(
    <TerminalLazyBoundary key="first" agentId="first" active />
  );
  await screen.findByTestId("terminal-panel");
  mounted.mockClear();
  rerender(
    <TerminalLazyBoundary key="second" agentId="second" active={false} />
  );
  expect(mounted).not.toHaveBeenCalled();
  expect(screen.queryByTestId("terminal-panel")).toBeNull();
});
