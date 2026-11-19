// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { Runner } from "@/hooks/use-runners";
import { RunnerHealthDetails } from "./runner-health";

vi.mock("./runner-onboarding", () => ({
  RunnerCommand: () => null,
  useRunnerInstaller: () => ({ data: undefined }),
}));

const runner: Runner = {
  id: "runner-1",
  name: "Build runner",
  status: "online",
  workspaces: [],
};
const receivedAt = "2026-01-15T08:42:17.123Z";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(["online", "offline"] as const)(
  "shows a relative report time and reveals the exact local timestamp on focus for an %s runner",
  async (status) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-15T08:43:25Z"));
    render(
      <RunnerHealthDetails
        runner={{
          ...runner,
          status,
          healthReceivedAt: receivedAt,
          health: {
            version: "1.2.3",
            sessions: 1,
            working: 0,
            cpuPercent: 4,
            memoryUsed: 256 * 1024 ** 2,
            memoryTotal: 1024 ** 3,
          },
        }}
      />
    );
    fireEvent.click(screen.getByText(/1 session/));

    const report = screen.getByText("1m ago");
    expect(report.getAttribute("datetime")).toBe(receivedAt);
    expect(report.tabIndex).toBe(0);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(report);

    const tooltip = await screen.findByRole("tooltip");
    expect(report.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(tooltip.textContent).toBe(
      new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "shortOffset",
      }).format(new Date(receivedAt))
    );
  }
);

it("preserves the no-sample state", () => {
  const { rerender } = render(<RunnerHealthDetails runner={runner} />);
  expect(screen.getByText("No health report received.")).toBeTruthy();
  expect(screen.queryByText("Last report")).toBeNull();

  rerender(<RunnerHealthDetails runner={{ ...runner, status: "offline" }} />);
  expect(screen.queryByText("No health report received.")).toBeNull();
  expect(screen.queryByText("Last report")).toBeNull();
});
