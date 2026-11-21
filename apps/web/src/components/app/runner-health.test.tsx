// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Runner } from "@/hooks/use-runners";
import { RunnerHealthDetails } from "./runner-health";

const installer = vi.hoisted(() => ({
  data: undefined as
    | {
        revision: string | null;
        version: string;
        source: "release" | "dev" | null;
        command: string | null;
      }
    | undefined,
}));

vi.mock("./runner-onboarding", () => ({
  RunnerCommand: ({ value, label }: { value: string; label: string }) => (
    <pre data-testid={`command-${label}`}>{value}</pre>
  ),
  useRunnerInstaller: () => installer,
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
  installer.data = undefined;
});

it.each(["online", "offline"] as const)(
  "reveals the exact local timestamp on focus or activation for an %s runner",
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

    const report = screen.getByRole("button", { name: "Last report: 1m ago" });
    expect(report.querySelector("time")?.getAttribute("datetime")).toBe(
      receivedAt
    );
    expect(report.tabIndex).toBe(0);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(report);

    const tooltip = await screen.findByRole("tooltip");
    expect(report.getAttribute("aria-describedby")).toBe(tooltip.id);
    const exactTime = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "shortOffset",
    }).format(new Date(receivedAt));
    expect(tooltip.textContent).toBe(exactTime);

    fireEvent.blur(report);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.click(report);
    expect((await screen.findByRole("tooltip")).textContent).toBe(exactTime);
  }
);

it("preserves the no-sample state", () => {
  const { rerender } = render(<RunnerHealthDetails runner={runner} />);
  expect(screen.getByText("No health report received.")).toBeTruthy();
  expect(screen.queryByText("Last report")).toBeNull();

  rerender(<RunnerHealthDetails runner={{ ...runner, status: "offline" }} />);
  expect(screen.getByText("No health report received.")).toBeTruthy();
  expect(screen.queryByText("Last report")).toBeNull();
});

describe("update command", () => {
  const command =
    "dispatch_runner_install() (\n  true\n)\ndispatch_runner_install";
  const health = (revision?: string) => ({
    ...runner,
    healthReceivedAt: receivedAt,
    health: {
      version: "1.2.3",
      ...(revision ? { revision } : {}),
      sessions: 0,
      working: 0,
      cpuPercent: 1,
      memoryUsed: 1024 ** 2,
      memoryTotal: 1024 ** 3,
    },
  });

  it("offers the controller's command when the runner reports another revision", () => {
    installer.data = {
      revision: "2c8f997d5349",
      version: "1.7.28",
      source: "release",
      command,
    };
    render(<RunnerHealthDetails runner={health("8fa2787f")} />);
    expect(screen.getByText(/Update available · 1\.7\.28/)).toBeTruthy();
    expect(screen.getByTestId("command-Update").textContent).toBe(command);
  });

  it.each([
    ["the same revision at another length", "2c8f997d5349", "2c8f997"],
    ["no reported revision", "2c8f997d5349", undefined],
    ["no command for this build", null, "8fa2787f"],
  ])("offers nothing for %s", (_case, controller, reported) => {
    installer.data = {
      revision: controller,
      version: "1.7.28",
      source: controller ? "release" : null,
      command: controller ? command : null,
    };
    render(<RunnerHealthDetails runner={health(reported)} />);
    expect(screen.queryByText(/Update available/)).toBeNull();
    expect(screen.queryByTestId("command-Update")).toBeNull();
  });
});
