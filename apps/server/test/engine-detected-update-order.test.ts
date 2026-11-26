import { expect, it, vi } from "vitest";
import { EngineRunnerExecutor } from "../../../packages/runner/src/workload/agents/remote/engine-runner-executor.js";

it("runs each detected update step behind its own request and release gate", async () => {
  const requests: string[] = [];
  let probes = 0;
  const hostCall = vi.fn(
    async (op: string, input: { requestId?: string; operationId?: string }) => {
      if (op === "engine.update.inspect")
        return {
          canUpdate: true,
          realPath: "/fixture",
          run: {
            executable: "install",
            args: [],
            refresh: { executable: "refresh", args: [] },
          },
        };
      if (op === "engine.update.probe")
        return { alive: [], version: ++probes === 1 ? "1.0.0" : "2.0.0" };
      if (op === "engine.update.spawn") {
        expect(input.requestId).toMatch(
          /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/
        );
        requests.push(input.requestId!);
        return { operationId: input.requestId, pid: 123 };
      }
      expect(input.operationId).toBe(requests.at(-1));
      if (op === "engine.update.release") return {};
      if (op === "engine.operation")
        return {
          type: "operation_state",
          running: false,
          output: "",
          outputOffset: 0,
          result: { exitCode: 0, stdout: "", stderr: "" },
        };
      throw new Error(op);
    }
  );
  const executor = new EngineRunnerExecutor({
    uid: 1000,
    gid: 1000,
    engines: {},
    env: {},
    hostCall: hostCall as never,
  });
  try {
    expect(
      await executor.handle({ type: "update", engine: "codex" })
    ).toMatchObject({
      ok: true,
      message: "Update completed. Verified installed version 2.0.0.",
    });
    expect(new Set(requests).size).toBe(2);
    expect(hostCall.mock.calls.map(([op]) => op)).toEqual([
      "engine.update.inspect",
      "engine.update.probe",
      "engine.update.spawn",
      "engine.update.release",
      "engine.operation",
      "engine.update.spawn",
      "engine.update.release",
      "engine.operation",
      "engine.update.probe",
    ]);
  } finally {
    executor.close();
  }
});
