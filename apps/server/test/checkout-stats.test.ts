import { isCheckoutViewData } from "@dispatch/runner-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { readAgentStats } from "../src/agents/checkout-runner.js";
import { readCheckoutView } from "../src/agents/checkout-view.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";
import { runCommand } from "../src/shared/lib/run-command.js";

vi.mock("../src/shared/lib/run-command.js");
afterEach(() => vi.restoreAllMocks());

const view = {
  kind: "stats",
  baseBranch: "main",
  includeUncommitted: true,
} as const;
const local = { cwd: "/repo", worktreePath: null, baseBranch: "main" };
const runner = { ...local, cwd: "runner://runner1/workspace1" };
const totals = { files: 1, added: 2, deleted: 0 };
const stats = { ...totals, excludingTests: totals, computedAt: 123 };

function service(read: () => unknown) {
  return {
    requestSession: async () => ({
      value: JSON.stringify({ data: await read() }),
    }),
  } as unknown as RemoteRunnerService;
}

it("validates optional stats outcomes and legacy data", () => {
  for (const data of [
    null,
    stats,
    { ...stats, outcome: "partial" },
    { ...stats, outcome: "success" },
  ])
    expect(isCheckoutViewData(view, data)).toBe(true);
  for (const outcome of [null, 1, {}, ["partial"], "no-data", "failure"])
    expect(isCheckoutViewData(view, { ...stats, outcome })).toBe(false);
});

it.each(["success", "partial"] as const)(
  "preserves %s across the runner wire",
  async (kind) => {
    vi.spyOn(Date, "now").mockReturnValue(123);
    vi.mocked(runCommand).mockImplementation(async (_command, args) => {
      const command = args[2];
      if (command === "check-ignore" && kind === "partial")
        throw new Error("Best-effort Git probe failed");
      const stdout =
        command === "diff"
          ? "2\t0\tsource.ts\n"
          : command === "rev-parse" || command === "merge-base"
            ? "abcdef\n"
            : "";
      return {
        exitCode: command === "check-ignore" ? 1 : 0,
        stdout,
        stderr: "",
      };
    });
    const native = await readAgentStats("agent", local);
    const remote = await readAgentStats(
      "agent",
      runner,
      service(() => readCheckoutView("/repo", view, true))
    );
    expect(native).toMatchObject({ kind, stats });
    expect(remote).toMatchObject({ kind: native.kind, stats: native.stats });
    if (remote.kind === "partial") expect(remote.error).toBeInstanceOf(Error);
  }
);

it("maps older runner stats to success or no data", async () => {
  await expect(
    readAgentStats(
      "agent",
      runner,
      service(() => stats)
    )
  ).resolves.toEqual({ kind: "success", stats });
  await expect(
    readAgentStats(
      "agent",
      runner,
      service(() => null)
    )
  ).resolves.toEqual({ kind: "no-data", stats: null });
});
