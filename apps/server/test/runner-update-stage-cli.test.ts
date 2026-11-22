import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runRunnerUpdateStage } from "../src/agents/remote/update-stage-cli.js";
import { probeStagedRunner } from "../src/agents/remote/update-probe.js";
import {
  RUNNER_UPDATE_LAYOUT,
  stageRunnerUpdate,
} from "../src/agents/remote/update-verify.js";

vi.mock("../src/agents/remote/update-keys.js", () => ({
  compiledRunnerDevKey: () => "fixture",
  compiledRunnerUpdateKeys: () => new Map(),
}));
vi.mock("../src/agents/remote/update-probe.js", () => ({
  probeStagedRunner: vi.fn(),
}));
vi.mock("../src/agents/remote/update-verify.js", { spy: true });

it("records and logs a probe failure without refusing the staged candidate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runner-stage-cli-"));
  const state = path.join(root, RUNNER_UPDATE_LAYOUT.state);
  vi.stubEnv("DISPATCH_RUNNER_UPDATE_TEST_ROOT", root);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const exitCode = process.exitCode;
  const target = {
    version: "1.7.29",
    os: "linux",
    arch: "x64",
    sha256: "a".repeat(64),
  } as const;
  const reason = "Runner compatibility probe failed (exit 1): fixture";
  vi.mocked(stageRunnerUpdate).mockResolvedValue({
    outcome: "staged",
    candidate: "candidate",
    target,
  });
  vi.mocked(probeStagedRunner).mockRejectedValue(new Error(reason));
  try {
    await mkdir(state, { recursive: true, mode: 0o700 });
    await runRunnerUpdateStage(["fixture"]);
    const expected = {
      outcome: "staged",
      target,
      compatibility: null,
      compatibilityError: reason,
    };
    expect(process.exitCode).toBe(0);
    expect(log).toHaveBeenCalledWith(JSON.stringify(expected));
    expect(
      JSON.parse(await readFile(path.join(state, "last-stage.json"), "utf8"))
    ).toMatchObject(expected);
  } finally {
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
