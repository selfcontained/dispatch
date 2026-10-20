// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalLauncher } from "./terminal-launcher";

const mounted = vi.hoisted(() => vi.fn());
vi.mock("./terminal-drawer", () => ({
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
    <TerminalLauncher agentId="agent" active={false} />
  );
  expect(mounted).not.toHaveBeenCalled();
  rerender(<TerminalLauncher agentId="agent" active />);
  expect((await screen.findByTestId("terminal-panel")).textContent).toBe(
    "visible"
  );
  rerender(<TerminalLauncher agentId="agent" active={false} />);
  expect(screen.getByTestId("terminal-panel").textContent).toBe("hidden");
});

it("defers a newly selected agent's panel until visible", async () => {
  const { rerender } = render(
    <TerminalLauncher key="first" agentId="first" active />
  );
  await screen.findByTestId("terminal-panel");
  mounted.mockClear();
  rerender(<TerminalLauncher key="second" agentId="second" active={false} />);
  expect(mounted).not.toHaveBeenCalled();
  expect(screen.queryByTestId("terminal-panel")).toBeNull();
});
