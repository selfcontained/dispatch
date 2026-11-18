import { spawn, execFile, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import {
  mkdir,
  writeFile,
  readFile,
  rm,
  chown,
  chmod,
  stat,
} from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import process from "node:process";
import { connect } from "node:tls";
import { promisify } from "node:util";
import { hostFile, type HostLaunch } from "../acp/host-protocol.js";
import {
  ownedEnvironment,
  killOwnedProcesses,
} from "../../shared/process/owned-processes.js";
import { hostCommand } from "../acp/runtime.js";
import { wireFrames, type Command, type Frame } from "./protocol.js";

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
  workspaces: Record<string, { cwd: string; repoTool?: string[] }>;
};

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

  const hosts = new Map<string, ChildProcess>();
  const active = new Set<string>();
  const owns = async (id: string, workspace: string) =>
    (await readFile(path.join(bindings, id), "utf8").catch(() => null)) ===
    workspace;

  async function launch(
    command: Extract<Command, { kind: "launch" }>,
    cwd: string
  ) {
    const { agentId, workspace } = command;
    if (hosts.has(agentId) || active.has(agentId))
      throw new Error("Runner already has a host for this agent");
    active.add(agentId);
    try {
      const binding = path.join(bindings, agentId);
      await writeFile(binding, workspace, { flag: "wx", mode: 0o600 }).catch(
        async (error) => {
          if (error.code !== "EEXIST" || !(await owns(agentId, workspace)))
            throw error;
        }
      );
      if (!(await stat(cwd)).isDirectory())
        throw new Error("Guest workspace is unavailable");
      const dir = path.join(hostRoot, agentId);
      const files = path.join(dir, "files");
      const launch: HostLaunch = {
        ...command.launch,
        agentId,
        cwd,
        bins: config.bins,
        env: {
          DISPATCH_AGENT_ID: agentId,
          DISPATCH_FILES_DIR: files,
          DISPATCH_API_URL: new URL(command.launch.mcp.url).origin,
          NODE_EXTRA_CA_CERTS: config.ca,
        },
        pathPrefix: [],
      };
      // Write only into a fresh directory: a previous CLI account could have
      // replaced anything under its old host directory with symlinks.
      await rm(dir, { force: true, recursive: true });
      await mkdir(dir, { mode: 0o700 });
      await mkdir(files, { mode: 0o700 });
      await chown(files, config.uid, config.gid);
      await writeFile(hostFile(dir, "launch"), JSON.stringify(launch), {
        mode: 0o600,
      });
      await chown(hostFile(dir, "launch"), config.uid, config.gid);
      await chown(dir, config.uid, config.gid);
      const log = openSync(path.join(logs, agentId), "a", 0o600);
      try {
        const [bin, ...args] = hostCommand();
        if (!bin) throw new Error("Runner host executable is missing");
        const owned = ownedEnvironment(env);
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
        host: endpoint.hostname,
        port: Number(endpoint.port || 443),
        servername: endpoint.hostname,
        rejectUnauthorized: true,
      });
      const channels = new Map<string, ReturnType<typeof createConnection>>();
      const timeout = setTimeout(() => socket.destroy(), 5000);
      socket.on("error", (error: Error) =>
        console.error("Runner transport:", error.message)
      );
      socket.on("close", () => {
        clearTimeout(timeout);
        for (const channel of channels.values()) channel.destroy();
        finished();
      });
      const safeSend = (frame: Frame) => {
        if (!socket.destroyed) {
          try {
            send(frame);
          } catch {
            socket.destroy();
          }
        }
      };

      async function request(id: string, command: Command) {
        if (!/^[a-f0-9-]{36}$/.test(id))
          throw new Error("Invalid runner request ID");
        if (socket.destroyed) return;
        const { agentId, workspace } = command;
        const target = Object.hasOwn(config.workspaces, workspace)
          ? config.workspaces[workspace]
          : undefined;
        if (!/^agt_[a-z0-9]+$/.test(agentId) || !target)
          throw new Error("Unknown runner workspace or agent");
        const result = (value?: string | boolean) =>
          safeSend({ type: "result", id, value });
        if (command.kind === "launch") {
          await launch(command, target.cwd);
          result(true);
          return;
        }
        if (!(await owns(agentId, workspace))) {
          if (command.kind === "alive") return result(false);
          throw new Error("Agent is not bound to this workspace");
        }
        if (socket.destroyed) return;
        const host = hosts.get(agentId);
        const dir = path.join(hostRoot, agentId);
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
            result(true);
            break;
          case "discard":
            if (host || active.has(agentId))
              throw new Error("Stop the guest host before discarding it");
            await rm(dir, { force: true, recursive: true });
            await rm(path.join(bindings, agentId), { force: true });
            result(true);
            break;
          case "log": {
            const log = await readFile(path.join(logs, agentId), "utf8").catch(
              () => ""
            );
            result(
              `Guest agent host ${host ? "log" : "exited"}.${log ? "\n" + log.slice(-2048) : ""}`
            );
            break;
          }
          case "repo": {
            const [bin, ...args] = target.repoTool ?? [];
            if (!bin)
              throw new Error(
                "Runner workspace has no approved repo operation"
              );
            const { stdout } = await execute(
              setpriv,
              [...childArgs, bin, ...args],
              {
                cwd: target.cwd,
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

      const send = wireFrames(socket, (frame) => {
        if (frame.type === "request") {
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
          version: 1,
          workspaces: Object.keys(config.workspaces),
        });
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
