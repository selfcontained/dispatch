import { runnerHealthSampler } from "./health.js";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import {
  mkdir,
  writeFile,
  readFile,
  rm,
  chown,
  chmod,
  stat,
  lstat,
  rename,
  realpath,
  rmdir,
} from "node:fs/promises";
import { createConnection, isIP } from "node:net";
import path from "node:path";
import process from "node:process";
import { connect } from "node:tls";
import { promisify } from "node:util";
import { hostFile, type HostLaunch } from "../acp/host-protocol.js";
import {
  ownedEnvironment,
  killOwnedProcesses,
} from "../../shared/process/owned-processes.js";
import {
  missingPath,
  prepareScratchSession,
  RunnerRepositories,
  type WorkloadCommand,
} from "./session-storage.js";
import { parseRepository } from "./repository.js";
import { hostCommand } from "../acp/runtime.js";
import {
  isOpaqueId,
  MANAGED_WORKSPACE,
  RUNNER_WIRE_VERSION,
  wireFrames,
  type Command,
  type RunnerFrame,
  type ServiceFrame,
  type RunnerEngine,
  type RunnerRepository,
} from "./protocol.js";
import {
  EngineRunnerExecutor,
  type ManagedCommand,
} from "./engine-runner-executor.js";

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

// Use the old storage name for existing prototype bindings. Other wire IDs
// never enter a filesystem path, even when they look like a relative path.
export function runnerStorageKey(agentId: string): string {
  return /^agt_[a-z0-9]+$/.test(agentId)
    ? agentId
    : `opaque-${createHash("sha256").update(agentId).digest("base64url")}`;
}

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
  const managedBinding = "\0managed";
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
  const bindings = path.join(config.state, "bindings");
  const hostRoot = path.join(config.state, "hosts");
  const logs = path.join(bindings, "logs");

  await mkdir(logs, { recursive: true, mode: 0o700 });
  await chmod(config.state, 0o711);
  await mkdir(hostRoot, { recursive: true, mode: 0o711 });
  await chmod(hostRoot, 0o711);

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
  const storage = await realpath(config.state);
  const sessions = path.join(storage, "sessions");
  const cache = path.join(storage, "repositories");
  for (const root of [sessions, cache]) {
    await mkdir(root, { mode: 0o711, recursive: true });
    await chmod(root, 0o711);
  }
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
  const repositories = new RunnerRepositories(
    cache,
    config.uid,
    config.gid,
    asWorkload
  );
  const hosts = new Map<string, ChildProcess>();
  const active = new Set<string>();
  const readOptional = (file: string) =>
    readFile(file, "utf8").catch(missingPath);
  const writePrivateState = async (file: string, contents: string) => {
    const temp = path.join(bindings, `.pending-${randomUUID()}`);
    try {
      await writeFile(temp, contents, { flag: "wx", mode: 0o600 });
      await rename(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
  };
  const readBinding = (key: string) => readOptional(path.join(bindings, key));
  const retireFile = (key: string) => path.join(bindings, `${key}.retired`);
  const repositoryFile = (key: string) =>
    path.join(bindings, `${key}.repository`);
  const markerFile = (key: string) => path.join(bindings, `${key}.owner`);

  async function stopFormerHost(key: string) {
    const marker = await readOptional(markerFile(key));
    if (marker) killOwnedProcesses(marker);
  }

  async function removeGuestDirectory(dir: string) {
    const entry = await lstat(dir).catch(missingPath);
    if (!entry) return;
    if (entry.uid === 0) {
      // Startup can fail before handing the fresh, private directory over.
      // The workload has never had access to this directory.
      await rm(dir, { force: true, recursive: true });
      return;
    }
    // Resolve and remove workload-owned content as the workload. The
    // supervisor only removes the now-empty, directly managed directory.
    await asWorkload("/usr/bin/find", [dir, "-mindepth", "1", "-delete"]);
    await rmdir(dir);
  }

  async function discardManaged(key: string, dir: string) {
    await writeFile(retireFile(key), "", { mode: 0o600 });
    await stopFormerHost(key);
    const session = path.join(sessions, key);
    const stored = await readOptional(repositoryFile(key));
    const repository =
      stored === null ? null : (JSON.parse(stored) as RunnerRepository | null);
    if (repository) await repositories.remove(session, repository);
    await removeGuestDirectory(session);
    await removeGuestDirectory(dir);
    await rm(repositoryFile(key), { force: true });
    await rm(markerFile(key), { force: true });
    await rm(path.join(logs, key), { force: true });
  }

  async function launch(
    command: Extract<Command, { kind: "launch" }>,
    cwd: string | undefined,
    key: string
  ) {
    const { agentId, workspace } = command;
    if (hosts.has(agentId) || active.has(agentId))
      throw new Error("Runner already has a host for this agent");
    active.add(agentId);
    try {
      const { mcp } = command.launch;
      const mcpUrl = mcp === undefined ? undefined : new URL(mcp.url);
      if (mcpUrl && (mcpUrl.protocol !== "https:" || !mcp?.token)) {
        throw new Error(
          "Remote service MCP requires HTTPS and a scoped token."
        );
      }
      const managed = managedWorkspace && workspace === MANAGED_WORKSPACE;
      if (!managed && command.launch.repository !== undefined)
        throw new Error(
          "Repository checkout requires a managed runner session."
        );
      if (managed && (await readOptional(retireFile(key))) !== null)
        throw new Error("This runner session has been archived.");

      const binding = path.join(bindings, key);
      const bindingValue = managed ? managedBinding : workspace;
      await writeFile(binding, bindingValue, { flag: "wx", mode: 0o600 }).catch(
        async (error) => {
          if (
            error.code !== "EEXIST" ||
            (await readBinding(key)) !== bindingValue
          )
            throw error;
        }
      );
      if (managed) {
        await stopFormerHost(key);
        const parsed =
          command.launch.repository === undefined
            ? null
            : parseRepository(command.launch.repository);
        if (parsed && !parsed.url)
          throw new Error("Missing runner repository URL.");
        const repository = parsed?.url
          ? { url: parsed.url, checkout: parsed.checkout }
          : null;
        const encoded = JSON.stringify(repository);
        const stored = await readOptional(repositoryFile(key));
        if (stored !== null && stored !== encoded)
          throw new Error(
            "This runner session is bound to a different checkout."
          );
        if (stored === null)
          await writePrivateState(repositoryFile(key), encoded);
        cwd = await prepareScratchSession(
          sessions,
          key,
          config.uid,
          config.gid
        );
        if (repository) cwd = await repositories.prepare(cwd, repository);
      }
      if (!cwd || (!managed && !(await stat(cwd)).isDirectory()))
        throw new Error("Guest workspace is unavailable");
      const dir = path.join(hostRoot, key);
      const files = path.join(dir, "files");
      const { repository: _repository, ...launchOptions } = command.launch;
      const launch: HostLaunch = {
        ...launchOptions,
        agentId,
        cwd,
        bins: config.bins,
        env: {
          DISPATCH_AGENT_ID: agentId,
          DISPATCH_FILES_DIR: files,
          ...(mcpUrl ? { DISPATCH_API_URL: mcpUrl.origin } : {}),
          NODE_EXTRA_CA_CERTS: config.ca,
        },
        pathPrefix: [],
        reportTurnActivity: true,
      };
      // Write only into a fresh directory: a previous CLI account could have
      // replaced anything under its old host directory with symlinks.
      if (managed) await removeGuestDirectory(dir);
      else await rm(dir, { force: true, recursive: true });
      await mkdir(dir, { mode: 0o700 });
      await mkdir(files, { mode: 0o700 });
      await chown(files, config.uid, config.gid);
      await writeFile(hostFile(dir, "launch"), JSON.stringify(launch), {
        mode: 0o600,
      });
      await chown(hostFile(dir, "launch"), config.uid, config.gid);
      await chown(dir, config.uid, config.gid);
      const log = openSync(path.join(logs, key), "a", 0o600);
      try {
        const [bin, ...args] = hostCommand();
        if (!bin) throw new Error("Runner host executable is missing");
        const owned = ownedEnvironment(env);
        if (managed) await writePrivateState(markerFile(key), owned.marker);
        const child = spawn(
          setpriv,
          [...childArgs, bin, ...args, "--state", dir],
          {
            cwd,
            env: owned.env,
            detached: true,
            stdio: ["ignore", log, log],
          }
        );
        hosts.set(agentId, child);
        const forget = () => {
          if (hosts.get(agentId) === child) hosts.delete(agentId);
        };
        child.on("exit", () => {
          try {
            killOwnedProcesses(owned.marker);
          } catch (error) {
            console.error(
              "Guest host descendant cleanup:",
              (error as Error).message
            );
          } finally {
            forget();
          }
        });
        child.on("error", forget);
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        child.unref();
      } finally {
        closeSync(log);
      }
    } finally {
      active.delete(agentId);
    }
  }

  while (true) {
    await new Promise<void>((finished) => {
      const socket = connect({
        ...credentials,
        host,
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
          const dirs = [...hosts.keys()].map((id) =>
            path.join(hostRoot, runnerStorageKey(id))
          );
          const sample = await sampleHealth(dirs);
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
        finished();
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
        const key = runnerStorageKey(agentId);
        const result = (value?: string | boolean) =>
          safeSend({ type: "result", id, value });
        if (command.kind === "launch") {
          await launch(command, target?.cwd, key);
          result(true);
          return;
        }
        const binding = await readBinding(key);
        if (binding !== (managed ? managedBinding : workspace)) {
          if (command.kind === "alive") return result(false);
          if (managed && binding === null && !active.has(agentId)) {
            if (command.kind === "stop") return result(true);
            if (command.kind === "discard") {
              active.add(agentId);
              try {
                await writeFile(retireFile(key), "", { mode: 0o600 });
              } finally {
                active.delete(agentId);
              }
              return result(true);
            }
          }
          throw new Error("Agent is not bound to this workspace");
        }
        if (socket.destroyed) return;
        const host = hosts.get(agentId);
        const dir = path.join(hostRoot, key);
        switch (command.kind) {
          case "attach": {
            if (!host) {
              safeSend({
                type: "result",
                id,
                code: "host-gone",
                error: "Guest agent host has exited.",
              });
              break;
            }
            const channel = createConnection(hostFile(dir, "socket"));
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
            result(Boolean(host));
            break;
          case "stop":
            if (host?.pid) {
              const exited = new Promise<void>((resolve) =>
                host.once("exit", () => resolve())
              );
              const signal = (value: NodeJS.Signals) => {
                try {
                  process.kill(-host.pid!, value);
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                    throw error;
                }
              };
              const timer = setTimeout(() => signal("SIGKILL"), 8_000);
              signal(command.force ? "SIGKILL" : "SIGTERM");
              try {
                await exited;
              } finally {
                clearTimeout(timer);
              }
            }
            if (managed && !active.has(agentId)) await stopFormerHost(key);
            result(true);
            break;
          case "discard":
            if (host || active.has(agentId))
              throw new Error("Stop the guest host before discarding it");
            active.add(agentId);
            try {
              if (managed) await discardManaged(key, dir);
              else await rm(dir, { force: true, recursive: true });
              await rm(path.join(bindings, key), { force: true });
            } finally {
              active.delete(agentId);
            }
            result(true);
            break;
          case "log": {
            const log = await readFile(path.join(logs, key), "utf8").catch(
              () => ""
            );
            result(
              `Guest agent host ${host ? "log" : "exited"}.${log ? "\n" + log.slice(-2048) : ""}`
            );
            break;
          }
          case "repo": {
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

      const send = wireFrames<ServiceFrame, RunnerFrame>(socket, (frame) => {
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
        });
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
