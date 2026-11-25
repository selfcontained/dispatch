import { expect, it, vi } from "vitest";
import {
  EngineUpdateOperations,
  type EngineOperationStore,
} from "../src/agents/engine-update-operations.js";
import { engineUpdatePort } from "./helpers/native-engine-updates.js";

it.each(["success", "lost release"] as const)(
  "invalidates the version cache around the gated update: %s",
  async (scenario) => {
    const events: string[] = [];
    const records = {};
    const store: EngineOperationStore = {
      exclusive: async (work) => work(records),
    };
    const port = engineUpdatePort({
      call: async (op: string) => {
        events.push(op);
        if (op === "engine.update.spawn")
          return { operationId: "fixture", pid: 123 };
        if (op === "engine.update.release") {
          if (scenario === "lost release") throw new Error("lost release");
          return {};
        }
        if (op === "engine.operation")
          return {
            type: "operation_state",
            running: false,
            output: "",
            outputOffset: 0,
            result: { stdout: "", stderr: "", exitCode: 0 },
          };
        throw new Error(op);
      },
    } as never);
    const manager = new EngineUpdateOperations(store, {
      ...port,
      clearEngineVersionCache: () => {
        events.push("clear");
        port.clearEngineVersionCache();
      },
      prepare: async () => ({
        realPath: "/fixture",
        source: "npm",
        canUpdate: true,
        reason: "",
        command: "fixture",
        latestKey: "fixture",
        target: "fixture",
        run: { executable: "fixture", args: [] },
      }),
      verify: async (_bin, phase) => {
        events.push(phase);
        return phase === "before" ? "1.0.0" : "2.0.0";
      },
    });
    await manager.start("codex", {});
    await vi.waitFor(async () =>
      expect((await manager.read()).codex?.status).toBe(
        scenario === "success" ? "succeeded" : "failed"
      )
    );
    expect(events).toEqual([
      "clear",
      "before",
      "engine.update.spawn",
      "engine.update.release",
      "engine.operation",
      ...(scenario === "success" ? ["clear", "after"] : []),
      "clear",
    ]);
  }
);
