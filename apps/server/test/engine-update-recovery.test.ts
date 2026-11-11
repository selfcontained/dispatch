import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  EngineUpdateOperations,
  observedUpdateRunner,
  type EngineOperationStore,
} from "../src/agents/engine-updates.js";

describe("fake installer recovery with real owned subprocesses", () => {
  it.each(["claude", "codex"] as const)(
    "%s handles slow download, loss, hang and successful retry without releasing a live job",
    async (id) => {
      const dir = await mkdtemp(
        path.join(os.tmpdir(), "dispatch-update-recovery-")
      );
      const version = path.join(dir, "version");
      const script = path.join(dir, "installer.sh");
      let mode = "slow";
      let records = {};
      let queue = Promise.resolve();
      const store: EngineOperationStore = {
        exclusive(work) {
          const result = queue.then(async () => {
            const copy = structuredClone(records);
            const value = await work(copy);
            records = copy;
            return value;
          });
          queue = result.then(
            () => {},
            () => {}
          );
          return result;
        },
      };
      try {
        await writeFile(version, "1.0.0");
        await writeFile(
          script,
          [
            'case "$1" in',
            'slow) echo downloading; sleep 0.2; echo 2.0.0 > "$2";;',
            'loss) echo "connection reset" >&2; exit 1;;',
            "hang) echo waiting; sleep 30;;",
            'retry) echo 3.0.0 > "$2";;',
            "esac",
          ].join("\n")
        );
        const manager = new EngineUpdateOperations(store, {
          prepare: async () => ({
            source: "npm",
            realPath: script,
            probePath: version,
            target: dir,
            canUpdate: true,
            reason: "Isolated fixture",
            command: "fixture",
            latestKey: "unknown:fixture",
            run: { executable: "/bin/sh", args: [script, mode, version] },
          }),
          verify: async (bin) => (await readFile(bin, "utf8")).trim(),
          runner: (observer) => (command, args, options) =>
            observedUpdateRunner(observer)(command, args, {
              ...options,
              timeoutMs: mode === "hang" ? 100 : 3_000,
            }),
        });
        const terminal = async (status: string) => {
          await vi.waitFor(
            async () => expect((await manager.read())[id]?.status).toBe(status),
            { timeout: 5_000 }
          );
          expect((await manager.read())[id]?.retryBlocked).toBe(false);
        };
        const operation = await manager.start(id, {});
        // A client that discards this acknowledgement can recover from GET.
        expect((await manager.read())[id]?.id).toBe(operation.id);
        await expect(manager.start(id, {})).rejects.toThrow("running");
        await terminal("succeeded");
        mode = "loss";
        await manager.start(id, {});
        await terminal("failed");
        expect((await manager.read())[id]?.output).toContain(
          "connection reset"
        );
        expect((await readFile(version, "utf8")).trim()).toBe("2.0.0");
        mode = "hang";
        await manager.start(id, {});
        await terminal("failed");
        expect((await manager.read())[id]?.output).toContain("timed out");
        mode = "retry";
        await manager.start(id, {});
        await terminal("succeeded");
        expect((await readFile(version, "utf8")).trim()).toBe("3.0.0");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );
});
