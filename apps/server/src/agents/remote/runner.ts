import { runnerHealthSampler } from "./health.js";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection, isIP } from "node:net";
import path from "node:path";
import process from "node:process";
import { connect } from "node:tls";
import { promisify } from "node:util";
import type { HostLaunch } from "../acp/host-protocol.js";
import type { WorkloadCommand } from "./session-storage.js";
import { createSessionSupervisor } from "./session-supervisor.js";
export { runnerStorageKey } from "./session-supervisor.js";
import { hostCommand, selfCommand } from "../acp/runtime.js";
import {
  isOpaqueId,
  MANAGED_WORKSPACE,
  RUNNER_WIRE_VERSION,
  wireFrames,
  parseServiceFrame,
  runnerRequestId,
  type Command,
  type RunnerFrame,
  type RunnerEngine,
} from "./protocol.js";
import {
  EngineRunnerExecutor,
  type ManagedCommand,
} from "./engine-runner-executor.js";

/** Keep the first redial fast. Spread retries when many offline runners start together. */
export function runnerReconnectDelay(random = Math.random) {
  let windowMs = 1000;
  return (connectedMs: number) => {
    if (connectedMs >= 30_000) windowMs = 1000;
    const delay = Math.round(windowMs * (0.5 + random() / 2));
    windowMs = Math.min(windowMs * 2, 30_000);
    return delay;
  };
}

type RunnerConfig = {
  endpoint: string;
  ca: string;
  trustBundle?: string;
  cert: string;
  key: string;
  state: string;
  uid: number;
  gid: number;
  home: string;
  path: string;
  bins: HostLaunch["bins"];
  adapter?: string[];
  workspaces?: Record<string, { cwd: string; repoTool?: string[] }>;
  /**
   * Operator-approved install/update commands per engine, run under the
   * same workload identity as everything else here. The launch path for
   * each engine comes from `bins` above, not from here — this only names
   * how to get (or refresh) what lives at that path. Omitted entirely for
   * runners that don't offer managed install/update.
   */
  engines?: Partial<
    Record<RunnerEngine, { install?: ManagedCommand; update?: ManagedCommand }>
  >;
};

export const runnerGitArgs = [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "http.followRedirects=false",
  "-c",
  "credential.helper=",
  "-c",
  "credential.https://github.com.helper=!/usr/bin/gh auth git-credential",
  "-c",
  "core.hooksPath=/dev/null",
];

const execute = promisify(execFile);
const setpriv = "/usr/bin/setpriv";

function validExecutionId(value: number) {
  return Number.isInteger(value) && value > 0 && value < 0xffffffff;
}

// Bun versions disagree on whether spawn and execFile apply uid/gid. Make
// the kernel privilege transition the same for the ACP host and repo tools.
function executionArgs(uid: number, gid: number) {
  return [
    `--reuid=${uid}`,
    `--regid=${gid}`,
    "--clear-groups",
    "--no-new-privs",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--bounding-set=-all",
    "--",
  ];
}

async function verifyExecutionIdentity(
  uid: number,
  gid: number,
  args: string[],
  env: NodeJS.ProcessEnv
) {
  try {
    const { stdout } = await execute(
      setpriv,
      [...args, "/bin/cat", "/proc/self/status"],
      {
        env,
        timeout: 5000,
      }
    );
    const fields = new Map(
      stdout.split("\n").map((line) => {
        const [key, value] = line.split(":", 2);
        return [key, (value ?? "").trim()];
      })
    );
    const matchesId = (key: string, expected: number) =>
      fields.get(key)?.split(/\s+/).join(" ") ===
      Array(4).fill(expected).join(" ");
    const capabilityFields = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];
    if (
      !matchesId("Uid", uid) ||
      !matchesId("Gid", gid) ||
      fields.get("Groups") !== "" ||
      fields.get("NoNewPrivs") !== "1" ||
      !capabilityFields.every((key) => /^0+$/.test(fields.get(key) ?? ""))
    ) {
      throw new Error(
        "the child retained privileges or used the wrong UID/GID"
      );
    }
  } catch (error) {
    throw new Error(
      "Runner cannot verify unprivileged execution with /usr/bin/setpriv.",
      { cause: error }
    );
  }
}

export async function runRemoteRunner(filename: string) {
  const config: RunnerConfig = JSON.parse(readFileSync(filename, "utf8"));
  const endpoint = new URL(config.endpoint);
  const host = endpoint.hostname.replace(/^\[|\]$/g, "");
  if (
    endpoint.protocol !== "https:" ||
    process.platform !== "linux" ||
    !validExecutionId(config.uid) ||
    !validExecutionId(config.gid) ||
    process.getuid?.() !== 0
  ) {
    throw new Error(
      "Runner requires an HTTPS endpoint and a separate, non-root execution account."
    );
  }
  const workspaces = config.workspaces ?? {};
  const configuredHandles = Object.keys(workspaces);
  if (!configuredHandles.every(isOpaqueId))
    throw new Error("Runner workspace IDs must be valid opaque identifiers.");
  const managedWorkspace = configuredHandles.length === 0;
  const env = {
    HOME: config.home,
    PATH: config.path,
    SHELL: "/bin/bash",
    NODE_EXTRA_CA_CERTS: config.ca,
    ...(config.trustBundle ? { SSL_CERT_FILE: config.trustBundle } : {}),
    ...(config.adapter
      ? { DISPATCH_ACP_ADAPTER_COMMAND: JSON.stringify(config.adapter) }
      : {}),
  };
  const childArgs = executionArgs(config.uid, config.gid);
  await verifyExecutionIdentity(config.uid, config.gid, childArgs, env);
  const credentials = {
    ca: readFileSync(config.ca),
    cert: readFileSync(config.cert),
    key: readFileSync(config.key),
  };
  const sampleHealth = runnerHealthSampler();
  const engineExecutor = new EngineRunnerExecutor({
    uid: config.uid,
    gid: config.gid,
    env,
    engines: {
      claude: { bin: config.bins.claudeBin || null, ...config.engines?.claude },
      codex: { bin: config.bins.codexBin || null, ...config.engines?.codex },
      opencode: {
        bin: config.bins.opencodeBin || null,
        ...config.engines?.opencode,
      },
    },
  });
  const asWorkload: WorkloadCommand = async (bin, args, opts) => {
    const { stdout } = await execute(
      setpriv,
      [...childArgs, bin, ...(opts?.git ? runnerGitArgs : []), ...args],
      {
        env: {
          ...env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GH_PROMPT_DISABLED: "1",
          ...(config.trustBundle ? { GIT_SSL_CAINFO: config.trustBundle } : {}),
        },
        timeout: opts?.git ? 90_000 : 20_000,
        maxBuffer: 512 * 1024,
      }
    );
    return stdout;
  };
  const supervisor = await createSessionSupervisor({
    ...config,
    env,
    workspaces: new Set(configuredHandles),
    asWorkload,
    hostCommand: () => [setpriv, ...childArgs, ...hostCommand()],
  });

  const nextDelay = runnerReconnectDelay();
  while (true) {
    const connectedMs = await new Promise<number>((finished) => {
      let connectedAt: number | undefined;
      const socket = connect({
        ...credentials,
        host,
        keepAlive: true,
        keepAliveInitialDelay: 30_000,
        port: Number(endpoint.port || 443),
        ...(isIP(host) ? {} : { servername: host }),
        rejectUnauthorized: true,
      });
      let healthInterval: ReturnType<typeof setInterval> | undefined;
      let sampling = false;
      const reportHealth = async () => {
        if (sampling || socket.destroyed) return;
        sampling = true;
        try {
          const sample = await sampleHealth(await supervisor.liveDirectories());
          safeSend({ type: "health", sample });
        } catch (error) {
          console.warn(
            "Runner health sample unavailable:",
            (error as Error).message
          );
        } finally {
          sampling = false;
        }
      };
      let acceptsInventory = false;
      let samplingEngines = false;
      const reportEngineInventory = async () => {
        if (!acceptsInventory || samplingEngines || socket.destroyed) return;
        samplingEngines = true;
        try {
          const entries = await engineExecutor.inventory();
          safeSend({ type: "engine_inventory", entries });
        } catch (error) {
          console.warn(
            "Runner engine inventory unavailable:",
            (error as Error).message
          );
        } finally {
          samplingEngines = false;
        }
      };
      const channels = new Map<string, ReturnType<typeof createConnection>>();
      const timeout = setTimeout(() => socket.destroy(), 5000);
      socket.on("error", (error: Error) =>
        console.error("Runner transport:", error.message)
      );
      socket.on("close", () => {
        clearTimeout(timeout);
        clearInterval(healthInterval);
        for (const channel of channels.values()) channel.destroy();
        finished(
          connectedAt === undefined ? 0 : performance.now() - connectedAt
        );
      });
      const safeSend = (frame: RunnerFrame) => {
        if (!socket.destroyed) {
          try {
            send(frame);
          } catch {
            socket.destroy();
          }
        }
      };

      async function request(id: string, command: Command) {
        if (!isOpaqueId(id)) throw new Error("Invalid runner request ID");
        if (socket.destroyed) return;
        if (command.kind === "engine") {
          const ack = await engineExecutor.handle(
            command.operation,
            (event) => {
              if (!socket.destroyed)
                safeSend({
                  type: "data",
                  id,
                  data: Buffer.from(
                    JSON.stringify(event) + "\n",
                    "utf8"
                  ).toString("base64"),
                });
            }
          );
          safeSend({ type: "result", id, value: JSON.stringify(ack) });
          if (command.operation.type !== "status") void reportEngineInventory();
          return;
        }
        const { agentId, workspace } = command;
        const target =
          isOpaqueId(workspace) && Object.hasOwn(workspaces, workspace)
            ? workspaces[workspace]
            : undefined;
        const managed = managedWorkspace && workspace === MANAGED_WORKSPACE;
        if (!isOpaqueId(agentId) || (!target && !managed))
          throw new Error("Unknown runner workspace or agent");
        const result = (value?: string | boolean) =>
          safeSend({ type: "result", id, value });
        if (command.kind === "launch") {
          await supervisor.launch(command, target?.cwd);
          result(true);
          return;
        }
        if (socket.destroyed) return;
        switch (command.kind) {
          case "inspectCheckout": {
            const cwd = await supervisor.checkoutDirectory(
              agentId,
              workspace,
              target?.cwd
            );
            const child = execute(
              setpriv,
              [...childArgs, ...selfCommand("runner-inspect-checkout"), cwd],
              {
                env: {
                  ...env,
                  GIT_TERMINAL_PROMPT: "0",
                  GH_PROMPT_DISABLED: "1",
                },
                timeout: 90_000,
                maxBuffer: 4 * 1024 * 1024,
              }
            );
            child.child.stdin?.on("error", () => {}); // execFile reports early child failure.
            child.child.stdin?.end(JSON.stringify(command.query));
            try {
              const { stdout } = await child;
              result(stdout.trimEnd());
            } catch (error) {
              // execFile's default message includes the command and machine-local paths.
              const detail = (error as { stderr?: string }).stderr
                ?.trim()
                .slice(0, 1024);
              throw new Error(
                detail || "The runner could not inspect the checkout."
              );
            }
            break;
          }
          case "attach": {
            const channel = await supervisor.attach(agentId, workspace);
            if (!channel) {
              safeSend({
                type: "result",
                id,
                code: "host-gone",
                error: "Guest agent host has exited.",
              });
              break;
            }
            if (socket.destroyed) {
              channel.destroy();
              break;
            }
            channels.set(id, channel);
            channel.once("connect", () => result(true));
            channel.on("data", (chunk: Buffer) =>
              safeSend({ type: "data", id, data: chunk.toString("base64") })
            );
            channel.on("error", () => {
              safeSend({
                type: "result",
                id,
                error: "Guest host socket is unavailable",
              });
              channel.destroy();
            });
            channel.on("close", () => {
              channels.delete(id);
              safeSend({ type: "close", id });
            });
            break;
          }
          case "alive":
            result(await supervisor.alive(agentId, workspace));
            break;
          case "stop":
            await supervisor.stop(agentId, workspace, command.force);
            result(true);
            break;
          case "discard":
            await supervisor.discard(agentId, workspace);
            result(true);
            break;
          case "log":
            result(await supervisor.log(agentId, workspace));
            break;
          case "repo": {
            if (!(await supervisor.isBound(agentId, workspace)))
              throw new Error("Agent is not bound to this workspace");
            const [bin, ...args] = target?.repoTool ?? [];
            if (!bin)
              throw new Error(
                "Runner workspace has no approved repo operation"
              );
            const { stdout } = await execute(
              setpriv,
              [...childArgs, bin, ...args],
              {
                cwd: target?.cwd,
                env,
                timeout: 10_000,
                maxBuffer: 64 * 1024,
              }
            );
            result(stdout);
            break;
          }
        }
      }

      const send = wireFrames<unknown, RunnerFrame>(socket, (value) => {
        if (socket.destroyed) return;
        const frame = parseServiceFrame(value);
        if (!frame) {
          const id = runnerRequestId(value);
          if (id !== undefined)
            safeSend({ type: "result", id, error: "Invalid runner command." });
          else socket.destroy();
          return;
        }
        if (frame.type === "accept_health" && !healthInterval) {
          acceptsInventory = frame.engineInventory === true;
          void reportHealth();
          void reportEngineInventory();
          healthInterval = setInterval(() => {
            void reportHealth();
            void reportEngineInventory();
          }, 30_000);
        } else if (frame.type === "request") {
          void request(frame.id, frame.command).catch((error) =>
            safeSend({
              type: "result",
              id: frame.id,
              error:
                error instanceof Error
                  ? error.message
                  : "Runner command failed",
            })
          );
        } else if (frame.type === "data") {
          const channel = channels.get(frame.id);
          if (channel && channel.writableLength > 32 * 1024 * 1024)
            channel.destroy();
          else channel?.write(Buffer.from(frame.data, "base64"));
        } else if (frame.type === "close") channels.get(frame.id)?.destroy();
        else socket.destroy();
      });
      socket.once("secureConnect", () => {
        connectedAt = performance.now();
        clearTimeout(timeout);
        safeSend({
          type: "ready",
          version: RUNNER_WIRE_VERSION,
          health: true,
          workspaces: managedWorkspace
            ? [MANAGED_WORKSPACE]
            : configuredHandles,
          ...(managedWorkspace ? { managedWorkspace: true } : {}),
          engineManagement: true,
          checkoutInspection: true,
          sharedWorktree: true,
        });
      });
    }).catch((error) => {
      supervisor.close();
      throw error;
    });
    await new Promise((resolve) => setTimeout(resolve, nextDelay(connectedMs)));
  }
}
