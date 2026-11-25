import { fixtureEngineActions } from "./helpers/engine-actions.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";

import {
  RunnerCallError,
  runnerIdFromWire,
} from "@dispatch/runner-protocol/contract";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
import { serveSocket } from "../../../packages/runner/src/local/socket-server.js";
import { engineHandlers } from "../../../packages/runner/src/core/engines.js";
import type { Platform } from "../../../packages/runner/src/platform/types.js";

import { localEngineWorkload } from "../src/agents/remote/engine-runner-executor.js";
import { EngineManager as ActualEngineManager } from "../src/agents/remote/engine-manager.js";

// T29 actions are supplied separately from legacy inventory/sign-in fixture transport.
class EngineManager extends ActualEngineManager {
  constructor(
    deps: Omit<
      ConstructorParameters<typeof ActualEngineManager>[0],
      "engineActions"
    >
  ) {
    super({
      ...deps,
      engineActions: fixtureEngineActions(deps),
    });
  }
}
import type { EngineUpdateOperations } from "./helpers/native-engine-updates.js";
import {
  localEngineCalls,
  type InProcessEngines,
} from "../src/runners/local.js";
import { registerEngineLoginRoutes } from "../src/routes/engine-login.js";
import { registerEngineManagementRoutes } from "../src/routes/engine-management.js";

export type GoldenVia = "child" | "in-process";

function untouchable(): InProcessEngines {
  const fail = () => {
    throw new Error("The in-process engine port was used.");
  };
  // An ID the child does not know is asked here too; this port has none.
  const none = async () => {
    throw new RunnerCallError({
      code: "not_found",
      message: "Sign-in not found.",
    });
  };
  return {
    updateInspect: fail,
    updateSpawn: fail,
    updateRelease: fail,
    updateProbe: fail,
    operation: fail,
    pluginStatus: fail,
    pluginApply: fail,
    list: fail,
    loginStart: fail,
    loginSubmit: none,
    loginStatus: none,
    loginCancel: none,
    close: () => {},
  };
}

/**
 * The app's wiring of the engine sign-in routes on fixture CLIs: the local
 * placement's runner child serving the core's engine handlers over its
 * socket, or the same port in process while the child is away.
 */
export async function buildEngineLoginApp(
  app: FastifyInstance,
  opts: {
    bins: { claude: string; codex: string; opencode: string };
    env: NodeJS.ProcessEnv;
    linkTimeoutMs?: number;
    via?: GoldenVia;
  }
): Promise<() => Promise<void>> {
  const port = () =>
    localEngineWorkload(opts.bins, {
      // Straight to the fixture CLI: no login shell, so no real HOME.
      command: (bin, args) => ({ bin, args }),
      env: opts.env,
      ...(opts.linkTimeoutMs ? { linkTimeoutMs: opts.linkTimeoutMs } : {}),
    });
  const inProcess = port();
  let child: LocalRunnerSession | undefined;
  let close = async () => {};
  if (opts.via === "child") {
    const served = port();
    const runtime = mkdtempSync(path.join(tmpdir(), "engine-golden-sock-"));
    const socketPath = path.join(runtime, "s");
    const nonce = randomUUID();
    const socket = await serveSocket(socketPath, nonce, {
      calls: engineHandlers({
        workload: {} as Platform["workload"],
        engines: served,
      }),
    });
    child = new LocalRunnerSession({
      description: {
        runnerId: runnerIdFromWire("local"),
        displayName: "Local",
        build: { version: "test" },
        protocol: 1,
        engines: [],
        capabilities: {},
      },
    });
    child.setEndpoint({ socket: socketPath, nonce });
    await child.call("runner.describe", {}).catch(() => {});
    close = async () => {
      child?.close();
      socket.close();
      served.close();
      rmSync(runtime, { recursive: true, force: true });
    };
  }
  const manager = new EngineManager({
    local: {
      // Through the child, nothing may reach the in-process port.
      engines: localEngineCalls(
        () => child,
        opts.via === "child" ? untouchable() : inProcess
      ),
      capabilities: { handle: async () => ({ ok: true }) },
      updates: {} as EngineUpdateOperations,
    },
    remote: { send: async () => ({ ok: false, error: "No runners." }) },
  });
  await registerEngineLoginRoutes(app, manager);
  await registerEngineManagementRoutes(app, manager);
  return async () => {
    await close();
    inProcess.close();
  };
}
