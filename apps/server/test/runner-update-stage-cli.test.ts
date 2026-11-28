import { packageVersion } from "../src/generated/runtime-assets.js";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { runRunnerUpdateStage as runWorkloadUpdateStage } from "../../../packages/runner/src/workload/agents/remote/update-stage-cli.js";
import { probeStagedRunner } from "../../../packages/runner/src/workload/agents/remote/update-probe.js";
import {
  parseRunnerUpdateInstance,
  RUNNER_UPDATE_LAYOUT,
  RunnerUpdateRefused,
  stageRunnerUpdate,
} from "../../../packages/runner/src/workload/agents/remote/update-verify.js";

vi.mock(
  "../../../packages/runner/src/workload/agents/remote/update-keys.js",
  () => ({
    compiledRunnerDevKey: () => "fixture",
    compiledRunnerUpdateKeys: () => new Map(),
  })
);
vi.mock(
  "../../../packages/runner/src/workload/agents/remote/update-probe.js",
  () => ({
    probeStagedRunner: vi.fn(),
  })
);
vi.mock(
  "../../../packages/runner/src/workload/agents/remote/update-verify.js",
  { spy: true }
);

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

it("records and logs the floor with a downgrade refusal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runner-stage-cli-"));
  const state = path.join(root, RUNNER_UPDATE_LAYOUT.state);
  vi.stubEnv("DISPATCH_RUNNER_UPDATE_TEST_ROOT", root);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitCode = process.exitCode;
  const instance = `1.7.29_linux_x64_${"a".repeat(64)}`;
  const message = "Refusing 1.7.29: below 1.7.31";
  vi.mocked(stageRunnerUpdate).mockRejectedValue(
    new RunnerUpdateRefused("downgrade", message, "1.7.31")
  );
  try {
    await mkdir(state, { recursive: true, mode: 0o700 });
    await runRunnerUpdateStage([instance]);
    expect(log).toHaveBeenCalledWith(
      `Runner update staging refused (downgrade): ${message}`
    );
    expect(
      JSON.parse(await readFile(path.join(state, "last-stage.json"), "utf8"))
    ).toMatchObject({
      outcome: "refused",
      reason: "downgrade",
      floorVersion: "1.7.31",
      target: parseRunnerUpdateInstance(instance),
    });
  } finally {
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});

function runRunnerUpdateStage(argv: string[]) {
  return runWorkloadUpdateStage(argv, { packageVersion });
}
