import { createInterface } from "node:readline";
import {
  RunnerCallError,
  operations,
} from "@dispatch/runner-protocol/contract";
import { isEngineHostCall } from "@dispatch/runner-protocol/engine-management";
import {
  localEngineWorkload,
  type ManagedCommand,
} from "./engine-runner-executor.js";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import type { RunnerEngine } from "@dispatch/runner-protocol";
import * as acp from "@agentclientprotocol/sdk";
import {
  isEngineCapabilityOperation,
  isEngineOperation,
  type EngineCapabilityOperation,
  type EngineModelCatalog,
  type EngineOperationAck,
} from "@dispatch/runner-protocol/engine-management";

import { withEngineBinDir } from "@dispatch/runner/host/engine-bin-dir";
import {
  engineSpecFor,
  type EngineBins,
} from "@dispatch/runner/host/engine-spec";
import { modelOptionOf, engineEffortOption } from "../engine-models.js";
import {
  CodexResetError,
  consumeCodexLimitReset,
  loadWorkloadProviderPlans,
} from "../provider-plans.js";
import {
  applyPluginUpdate,
  checkPluginStatus,
} from "../../shared/plugin-status.js";
import { childProcessEnv } from "../../shared/process/child-environment.js";
import { parseEngineCapabilityResult } from "./engine-capability-result.js";

export async function readCatalog(
  engine: RunnerEngine,
  bins: EngineBins,
  model?: string
): Promise<EngineModelCatalog> {
  const spec = engineSpecFor(engine, bins, false);
  const bin = {
    claude: bins.claudeBin,
    codex: bins.codexBin,
    opencode: bins.opencodeBin,
  }[engine];
  const cwd = process.env.HOME!;
  const child = spawn(spec.bin, spec.args, {
    cwd,
    env: {
      ...spec.envDefaults,
      ...childProcessEnv(),
      ...spec.env,
      PATH: bin ? withEngineBinDir(process.env.PATH, bin) : process.env.PATH,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const conn = new acp.ClientSideConnection(
      () => ({
        async sessionUpdate() {},
        async requestPermission() {
          return { outcome: { outcome: "cancelled" } };
        },
      }),
      acp.ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout)
      )
    );
    const read = async () => {
      await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION });
      const session = await conn.newSession({ cwd, mcpServers: [] });
      const options = session.configOptions ?? [];
      const report = modelOptionOf(options);
      const modelOption = options.find(
        (option) =>
          option.type === "select" &&
          (option.category === "model" || option.id === "model")
      );
      const defaultModel =
        report?.current === "default" ? null : (report?.current ?? null);
      let selected = report?.current;
      let reportedOptions = options;
      if (model && model !== selected) {
        if (
          !modelOption ||
          !report?.choices.some((choice) => choice.id === model)
        ) {
          throw new Error("Model unavailable");
        }
        ({ configOptions: reportedOptions } = await conn.setSessionConfigOption(
          {
            sessionId: session.sessionId,
            configId: modelOption.id,
            value: model,
          }
        ));
        selected = modelOptionOf(reportedOptions)?.current;
      }
      const effort = engineEffortOption(reportedOptions);
      return {
        current: selected,
        defaultModel,
        models: (report?.choices ?? []).map(({ id, label }) => ({
          id,
          label,
          ...(id === selected ? { effort } : {}),
        })),
      };
    };
    const stop = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error("Catalog timed out")),
        15_000
      );
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Adapter exited")));
    });
    return await Promise.race([read(), stop]);
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
  }
}

async function handle(
  operation: EngineCapabilityOperation,
  bins: EngineBins,
  secret: string
): Promise<EngineOperationAck> {
  switch (operation.type) {
    case "model_catalog":
      return {
        ok: true,
        capability: {
          type: operation.type,
          catalog: await readCatalog(operation.engine, bins, operation.model),
        },
      };
    case "provider_usage":
      return {
        ok: true,
        capability: {
          type: operation.type,
          usage: await loadWorkloadProviderPlans(secret),
        },
      };
    case "codex_reset": {
      try {
        const { code, windowsReset } = await consumeCodexLimitReset({
          requestId: operation.requestId,
          account: { handle: operation.account, secret },
        });
        return {
          ok: true,
          capability: {
            type: operation.type,
            code: ["ok", "nothing_to_reset", "no_credit"].includes(code)
              ? code
              : "unknown",
            windowsReset,
          },
        };
      } catch (error) {
        if (
          error instanceof CodexResetError &&
          error.reason === "account_changed"
        ) {
          return {
            ok: false,
            reason: "account_changed",
            error:
              "The Codex account changed. Refresh usage before trying again.",
          };
        }
        return {
          ok: false,
          error:
            "Codex did not confirm the reset. Refresh usage before trying again.",
        };
      }
    }
    case "plugin_status":
    case "plugin_install":
    case "plugin_update": {
      const bin =
        operation.engine === "claude" ? bins.claudeBin : bins.codexBin;
      // The wire accepts an identifier. The implementation supplies the
      // marketplace source itself and only manages its provisioned plugin.
      if (operation.plugin !== "dispatch@dispatch" || !bin) {
        return {
          ok: false,
          unsupported: true,
          error: "Plugin management is unavailable on this runner.",
        };
      }
      const change = operation.type !== "plugin_status";
      const result = change
        ? await applyPluginUpdate(
            operation.engine,
            bin,
            undefined,
            undefined,
            operation.type === "plugin_install" ? "install" : "update"
          )
        : null;
      if (result?.error) return { ok: false, error: result.error };
      const status =
        result?.status ?? (await checkPluginStatus(operation.engine, bin));
      if (status.detectionError)
        return {
          ok: false,
          error: "Could not read plugin status on this runner.",
        };
      return {
        ok: true,
        capability: {
          type: "plugin_status",
          status: {
            ...status,
            actions: status.installed ? ["update"] : ["install"],
          },
        },
      };
    }
  }
}

export async function runEngineCapabilityWorker(): Promise<void> {
  let ack: EngineOperationAck = {
    ok: false,
    error: "Engine capability is unavailable on this runner.",
  };
  try {
    const { operation, bins, secret } = await Bun.stdin.json();
    if (
      isEngineOperation(operation) &&
      isEngineCapabilityOperation(operation)
    ) {
      const result = await handle(operation, bins, secret);
      if (!result.ok) ack = result;
      else {
        const capability = parseEngineCapabilityResult(
          operation,
          result.capability
        );
        if (capability) ack = { ok: true, capability };
      }
    }
  } catch {
    // Adapter stderr, local paths and provider bodies stay on the workload.
  }
  process.stdout.write(JSON.stringify(ack));
}

/** Persistent workload port: gates and plugin TTLs span request connections. */
export async function runEngineHostWorker(): Promise<void> {
  const bins: Partial<Record<RunnerEngine, string>> & {
    adapter?: EngineBins["adapter"];
  } = { claude: "claude", codex: "codex", opencode: "opencode" };
  const updates: Partial<
    Record<"claude" | "codex" | "opencode", ManagedCommand>
  > = {};
  const installs: Partial<
    Record<"claude" | "codex" | "opencode", ManagedCommand>
  > = {};
  const port = localEngineWorkload(bins, { updates, installs });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    void (async () => {
      const message = JSON.parse(line);
      const call: unknown = message.call;
      if (!Number.isSafeInteger(message.id) || !isEngineHostCall(call))
        throw new Error("Invalid engine host call.");
      Object.assign(bins, message.bins);
      bins.adapter = message.adapter;
      for (const engine of ["claude", "codex", "opencode"] as const) {
        delete updates[engine];
        delete installs[engine];
      }
      Object.assign(updates, message.updates);
      Object.assign(installs, message.installs);
      const { op, request } = call;
      try {
        let data;
        switch (op) {
          case "engine.models":
            data = await port.models(request);
            break;
          case "engine.usage":
            data = await port.usage(request);
            break;
          case "engine.quota.reset":
            data = await port.quotaReset(request);
            break;
          case "engine.list":
            data = await port.list(request);
            break;
          case "engine.login.start":
            data = await port.loginStart(request);
            break;
          case "engine.login.submit":
            data = await port.loginSubmit(
              request as { loginId: string; code: string }
            );
            break;
          case "engine.login.status":
            data = await port.loginStatus(request as { loginId: string });
            break;
          case "engine.login.cancel":
            data = await port.loginCancel(request as { loginId: string });
            break;
          case "engine.update.inspect":
            data = await port.updateInspect(request);
            break;
          case "engine.update.spawn":
            data = await port.updateSpawn(request);
            break;
          case "engine.update.release":
            data = await port.updateRelease(request);
            break;
          case "engine.update.probe":
            data = await port.updateProbe(request);
            break;
          case "engine.operation":
            data = await port.operation(request);
            break;
          case "engine.plugin.status":
            data = await port.pluginStatus(request);
            break;
          case "engine.plugin.apply":
            data = await port.pluginApply(request);
            break;
        }
        if (!operations[op].response.check(data))
          throw new Error("Invalid engine host result.");
        process.stdout.write(JSON.stringify({ id: message.id, data }) + "\n");
      } catch (error) {
        process.stdout.write(
          JSON.stringify({
            id: message.id,
            error:
              error instanceof RunnerCallError
                ? {
                    code: error.code,
                    message: error.message,
                    ...(error.details !== undefined && {
                      details: error.details,
                    }),
                  }
                : { code: "failed", message: String(error) },
          }) + "\n"
        );
      }
    })().catch(() => {
      process.exitCode = 1;
      lines.close();
      process.stdin.destroy();
    });
  });
  await new Promise<void>((resolve) => lines.on("close", resolve));
  port.close();
}
