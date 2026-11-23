import { embeddedBuild } from "../build-identity.js";
import { childProcessEnv } from "../../shared/process/child-environment.js";
import { executionArgs, setpriv } from "./workload-identity.js";
import { runnerHealthSampler } from "./health.js";
import { SharedCheckoutWatches, childWatch } from "../checkout-watch.js";
import { sessionFileCommand } from "./session-files.js";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createConnection, isIP } from "node:net";
import path from "node:path";
import process from "node:process";
import { connect } from "node:tls";
import { Duplex, PassThrough, Readable, Writable } from "node:stream";
import { checkoutWorkerStderr } from "../checkout-command-executor.js";
import { terminalEnvironment } from "../../terminal/pty.js";
import { promisify } from "node:util";
import type { HostLaunch } from "../acp/host-protocol.js";
import type { WorkloadCommand } from "./session-storage.js";
import {
  createSessionSupervisor,
  type SessionCoreFactory,
} from "./session-supervisor.js";
export { runnerStorageKey } from "./session-supervisor.js";
import { hostCommand, selfCommand } from "../acp/host-command.js";
import {
  RunnerCallError,
  displayPath,
  runnerError,
  sessionFromWire,
  sessionToWire,
  type Req,
  type Res,
} from "@dispatch/runner-protocol/contract";
import {
  runnerReplyTimeoutMs,
  scheduleDeadline,
} from "../../runners/enrolled/v1-framing.js";
import {
  TERMINAL_UPDATE_MESSAGE,
  UPDATE_FENCED_MESSAGE,
  UpdateAdmission,
  type FenceStore,
} from "./update-admission.js";
import {
  createRunnerUpdateAgent,
  detectSelfUpdate,
  systemdRunnerUpdater,
  trialHelperAvailable,
  type RunnerUpdater,
  type UpdateIdentity,
} from "./update-agent.js";
import { fileFenceStore } from "./update-fence-store.js";
import {
  RUNNER_UPDATE_LAYOUT,
  type RunnerUpdateLayout,
} from "./update-verify.js";
import {
  isOpaqueId,
  isTerminalEvent,
  isTerminalInfo,
  MAX_TERMINAL_FRAME_LENGTH,
  MANAGED_WORKSPACE,
  RUNNER_WIRE_VERSION,
  MAX_CHECKOUT_VIEW_BYTES,
  checkoutCommandTimeoutMs,
  isCheckoutCommandStatus,
  type CheckoutExecution,
  MAX_CHECKOUT_COMMAND_REPLY_BYTES,
  parseServiceFrame,
  parseLaunchProgress,
  runnerRequestId,
  UPDATE_SERVICE_FRAME_TYPES,
  type Command,
  MAX_SESSION_FILE_BASE64,
  type RunnerFrame,
  type RunnerEngine,
} from "@dispatch/runner-protocol";
import {
  isEngineCapabilityOperation,
  type EngineCapabilityOperation,
  type EngineOperationAck,
} from "@dispatch/runner-protocol/engine-management";
import {
  wireFrames,
  FlowStreams,
  acceptsStreams,
  type StreamFrame,
} from "../../runners/enrolled/v1-framing.js";
import { GitHubRunnerExecutor } from "./github-runner-executor.js";
import {
  WorkloadTools,
  cacheWorkloadPath,
  workloadPathProbe,
  githubCredentialHelper,
  githubCredentialKey,
  missingExecutable,
  systemTools,
  workloadLoginCommand,
  workloadToolLookup,
} from "./workload-tools.js";
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

export const runnerGitArgsFor = (gh: string) => [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "http.followRedirects=false",
  "-c",
  "credential.helper=",
  "-c",
  `${githubCredentialKey}=${githubCredentialHelper(gh)}`,
  "-c",
  "core.hooksPath=/dev/null",
];

export const runnerGitArgs = runnerGitArgsFor(systemTools.gh);

const execute = promisify(execFile);

function validExecutionId(value: number) {
  return Number.isInteger(value) && value > 0 && value < 0xffffffff;
}

function startCheckoutWorker(
  [command, ...args]: [string, ...string[]],
  env: NodeJS.ProcessEnv,
  input: string
) {
  if (typeof Bun !== "undefined") {
    // Bun's node:child_process bridge can miss completion after the process
    // has exited. Use its native process handle and consume the pipes directly.
    const child = Bun.spawn([command, ...args], {
      detached: true,
      env,
      stdin: Buffer.from(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      pid: child.pid,
      stdout: Readable.from(child.stdout ?? [], { objectMode: false }),
      stderr: Readable.from(child.stderr ?? [], { objectMode: false }),
      exited: child.exited.then((code) => String(child.signalCode ?? code)),
    };
  }
  const child = spawn(command, args, {
    detached: true,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(String(code ?? signal)));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  return { pid: child.pid, stdout: child.stdout, stderr: child.stderr, exited };
}

function stopCheckoutWorker(child: ReturnType<typeof startCheckoutWorker>) {
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The process group may already have exited.
    }
  }
  child.stdout.destroy();
  child.stderr.destroy();
}

async function waitForCheckoutWorker<T>(signal: AbortSignal, work: Promise<T>) {
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    return await Promise.race([cancelled.promise, work]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function runCheckoutWorker(
  args: string[],
  env: NodeJS.ProcessEnv,
  input: string,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted();
  const child = startCheckoutWorker([setpriv, ...args], env, input);
  const stdout: Buffer[] = [];
  let bytes = 0;
  let stderr = "";
  async function collectOutput() {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (bytes > MAX_CHECKOUT_COMMAND_REPLY_BYTES)
        throw new Error("Checkout command reply exceeded its output limit.");
      stdout.push(chunk);
    }
  }
  async function collectErrors() {
    for await (const chunk of child.stderr as AsyncIterable<Buffer>) {
      if (stderr.length < 1024)
        stderr = (stderr + Buffer.from(chunk).toString()).slice(0, 1024);
    }
  }
  const [status] = await waitForCheckoutWorker(
    signal,
    Promise.all([child.exited, collectOutput(), collectErrors()])
  ).catch((error) => {
    stopCheckoutWorker(child);
    throw error;
  });
  if (status !== "0") throw new Error(stderr || "Checkout worker failed.");
  return Buffer.concat(stdout).toString("utf8");
}

/** The workload process owns the command. Its parent only forwards bounded
 * chunks and kills the process group when any part of the transfer fails. */
export async function streamCheckoutWorker(
  command: [string, ...string[]],
  env: NodeJS.ProcessEnv,
  input: string,
  execution: CheckoutExecution,
  streams: FlowStreams,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  const child = startCheckoutWorker(command, env, input);
  let truncated = false;
  async function* limitOutput(source: AsyncIterable<Buffer>) {
    let remaining = execution.maxOutput ?? Infinity;
    for await (const chunk of source) {
      if (chunk.length > remaining) truncated = true;
      const kept = chunk.subarray(0, remaining);
      remaining -= kept.length;
      if (kept.length) yield kept;
    }
  }
  let status = "";
  const stderr = checkoutWorkerStderr(child.stderr, (value) => {
    status = value;
  });
  const controller = new AbortController();
  const transfer = AbortSignal.any([signal, controller.signal]);
  const send = (id: string, source: AsyncIterable<Buffer>) =>
    streams.send(
      id,
      Readable.from(limitOutput(source), { objectMode: false }),
      transfer,
      { stall: "blocked" }
    );
  // Either output can finish before the worker exits. Cancellation must
  // release the checkout even if neither transfer is still listening.
  let completed = false;
  try {
    const [workerStatus] = await waitForCheckoutWorker(
      signal,
      Promise.all([
        child.exited,
        send(execution.stdout, child.stdout),
        send(execution.stderr, stderr),
      ])
    );
    completed = true;
    const value = JSON.parse(status || "null");
    if (workerStatus === "1" && value?.code === "stale")
      throw new RunnerCallError({ code: "stale", message: value.error });
    if (workerStatus !== "0" || !isCheckoutCommandStatus(value))
      throw new Error(
        value?.error || `Checkout worker failed (status ${workerStatus}).`
      );
    return JSON.stringify({ exitCode: value.exitCode, truncated });
  } finally {
    controller.abort();
    if (!completed) stopCheckoutWorker(child);
  }
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
    const groups = fields.get("Groups")?.split(/\s+/);
    const capabilityFields = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];
    if (
      !matchesId("Uid", uid) ||
      !matchesId("Gid", gid) ||
      !groups?.includes(String(gid)) ||
      !groups.every((group) => validExecutionId(Number(group))) ||
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

/** Host attach and inspection stay available behind the update fence. */
const FENCE_EXEMPT = new Set<Command["kind"]>(["attach", "alive", "log"]);

/** Test seams. Production uses the installed root updater layout. */
type WorkspaceOp =
  | "workspace.prepare"
  | "workspace.resume"
  | "workspace.release";
type WorkspacePreparationFactory = (options: {
  state: string;
  ids: { supervisor: number; uid: number; gid: number };
  asWorkload: WorkloadCommand;
  step: (op: string, args: unknown[]) => Promise<unknown>;
}) => Promise<{
  legacy(session: string): Promise<boolean>;
  hasReceipt(session: string): Promise<boolean>;
  remove(session: string): Promise<boolean>;
  releaseLegacy(
    session: string,
    source: string | null,
    request: Omit<Req<"workspace.release">, "session">
  ): Promise<boolean>;
  call<K extends WorkspaceOp>(
    op: K,
    request: Req<K>,
    emit: (event: unknown) => void
  ): Promise<Res<K>>;
}>;

export type RunnerUpdateOptions = {
  updateLayout?: RunnerUpdateLayout;
  fenceStore?: FenceStore;
  updater?: RunnerUpdater;
  /** Undefined detects the installed identity; null disables the capability. */
  updateIdentity?: UpdateIdentity | null;
  terminalGraceMs?: number;
  createWorkspacePreparation?: WorkspacePreparationFactory;
  /** The runner's session core; the supervisor needs it to start. */
  createSessions?: SessionCoreFactory;
  streamHelper?: string;
};

type RunnerOutput = RunnerFrame | StreamFrame;

/**
 * Bun's child_process can close an extra stdio pipe again when the child
 * is collected, by which time the descriptor may belong to another worker.
 * Route readiness through the standard stderr pipe. The shell moves it to
 * fd 3 before exec so closing fd 3 still immediately signals readiness EOF.
 */
export function startTerminalWorker(
  [privilegeCommand, ...privilegeArgs]: [string, ...string[]],
  command: string[],
  env: NodeJS.ProcessEnv
) {
  return spawn(
    privilegeCommand,
    [
      ...privilegeArgs,
      "/bin/sh",
      "-c",
      'exec 3>&2 2>/dev/null; exec "$@"',
      "terminal-worker",
      ...command,
    ],
    { env, stdio: ["pipe", "pipe", "pipe"] }
  );
}

export async function runRemoteRunner(
  filename: string,
  updateOptions: RunnerUpdateOptions = {}
) {
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
  const { stdout: account } = await execute(
    "/usr/bin/getent",
    ["passwd", String(config.uid)],
    { env: childProcessEnv(), timeout: 5000 }
  );
  const [username, , , , , , passwdShell] = account.trimEnd().split(":");
  const shell =
    passwdShell &&
    path.isAbsolute(passwdShell) &&
    !["nologin", "false"].includes(path.basename(passwdShell)) &&
    existsSync(passwdShell)
      ? passwdShell
      : "/bin/bash";
  const workloadLogin = (command: string[]) => [
    ...childArgs,
    ...workloadLoginCommand(command, shell, config.home, config.path),
  ];
  const env = {
    HOME: config.home,
    PATH: config.path,
    SHELL: shell,
    USER: username,
    LOGNAME: username,
    NODE_EXTRA_CA_CERTS: config.ca,
    ...(config.trustBundle ? { SSL_CERT_FILE: config.trustBundle } : {}),
  };
  const childArgs = executionArgs(config.uid, config.gid);
  await verifyExecutionIdentity(config.uid, config.gid, childArgs, env);
  const loginPath = cacheWorkloadPath(async () => {
    const { stdout } = await execute(
      setpriv,
      workloadLogin(workloadPathProbe),
      {
        env,
        timeout: 5000,
        maxBuffer: 64 * 1024,
      }
    );
    return stdout;
  });
  // Read a persisted fence before anything can be admitted, so a restarted
  // supervisor or a candidate build in its trial starts fenced.
  const updateLayout = updateOptions.updateLayout ?? RUNNER_UPDATE_LAYOUT;
  const admission = await UpdateAdmission.load(
    updateOptions.fenceStore ?? fileFenceStore(updateLayout.state),
    {
      terminalGraceMs: updateOptions.terminalGraceMs,
      log: (message) => console.warn(message),
    }
  );
  // Every self-spawn goes through here. Once the fence has drained nothing
  // new starts: after a rename these paths would run the new build.
  const self = (mode: string) => {
    admission.assertMayStartProcess();
    return selfCommand(mode);
  };
  const credentials = {
    ca: readFileSync(config.ca),
    cert: readFileSync(config.cert),
    key: readFileSync(config.key),
  };
  const sampleHealth = runnerHealthSampler(
    path.dirname(updateLayout.installed)
  );
  // gh and git come from the workload account's own login environment, the
  // one its agent sessions get, not from whatever the system package put in
  // /usr/bin. Looked up once; a missing resolved path triggers a new lookup.
  const tools = new WorkloadTools(async () => {
    const { stdout } = await execute(
      setpriv,
      [...childArgs, ...workloadToolLookup(shell, config.home, config.path)],
      { env, cwd: config.home, timeout: 15_000, maxBuffer: 64 * 1024 }
    );
    return stdout;
  });
  const github = new GitHubRunnerExecutor(
    env,
    (bin, args) => ({
      bin: setpriv,
      args: [...childArgs, bin, ...args],
    }),
    credentials.key,
    tools,
    username === "dispatch-runner" &&
      config.home === "/var/lib/dispatch-runner/home" &&
      passwdShell === "/usr/sbin/nologin"
  );
  const engineExecutor = new EngineRunnerExecutor({
    bundledRuntime: process.versions.bun ? process.execPath : undefined,
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
  // Hosts and catalog reads take an adapter override only through their bins.
  const [adapterBin, ...adapterArgs] = config.adapter ?? [];
  const bins: HostLaunch["bins"] = adapterBin
    ? { ...config.bins, adapter: { bin: adapterBin, args: adapterArgs } }
    : config.bins;
  async function resolveBins(
    engine?: RunnerEngine
  ): Promise<HostLaunch["bins"]> {
    switch (engine) {
      case "claude":
        return {
          ...bins,
          claudeBin: (await engineExecutor.resolveBin(engine)) ?? "",
        };
      case "codex":
        return {
          ...bins,
          codexBin: await engineExecutor.resolveBin(engine),
        };
      case "opencode":
        return {
          ...bins,
          opencodeBin: await engineExecutor.resolveBin(engine),
        };
      default:
        return bins;
    }
  }
  const engineAccountSecret = randomBytes(32).toString("base64url");
  const capabilityRequests = new Set<string>();
  async function engineCapability(
    operation: EngineCapabilityOperation,
    signal: AbortSignal
  ): Promise<EngineOperationAck> {
    const key =
      operation.type.startsWith("plugin_") && "engine" in operation
        ? `plugin:${operation.engine}`
        : JSON.stringify(
            operation.type === "codex_reset" ? operation.type : operation
          );
    if (capabilityRequests.has(key) || capabilityRequests.size >= 8) {
      return {
        ok: false,
        error:
          "An engine capability request is already in progress. Try again shortly.",
      };
    }
    capabilityRequests.add(key);
    try {
      const bins = await resolveBins(
        "engine" in operation ? operation.engine : undefined
      );
      const child = execute(
        setpriv,
        [...childArgs, ...self("runner-engine-capability")],
        {
          env,
          cwd: config.home,
          timeout: operation.type.startsWith("plugin_") ? 160_000 : 20_000,
          maxBuffer: 192 * 1024,
          signal,
        }
      );
      child.child.stdin?.on("error", () => {});
      child.child.stdin?.end(
        JSON.stringify({
          operation,
          bins,
          secret: engineAccountSecret,
        })
      );
      return JSON.parse((await child).stdout);
    } catch {
      return {
        ok: false,
        error: "Engine capability is unavailable on this runner.",
      };
    } finally {
      capabilityRequests.delete(key);
    }
  }
  const asWorkload: WorkloadCommand = async (bin, args, opts) => {
    const resolved = bin === "git" ? await tools.resolve("git") : bin;
    const gitArgs = opts?.git
      ? runnerGitArgsFor(await tools.resolve("gh"))
      : [];
    const { stdout } = await execute(
      setpriv,
      [...childArgs, resolved, ...gitArgs, ...args],
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
    ).catch((error: unknown) => {
      if (resolved !== bin && missingExecutable(error)) tools.invalidate();
      throw error;
    });
    return stdout;
  };
  const checkoutGitEnv = async () => ({
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: githubCredentialKey,
    GIT_CONFIG_VALUE_0: githubCredentialHelper(await tools.resolve("gh")),
  });
  let workspacePreparation:
    | Awaited<ReturnType<WorkspacePreparationFactory>>
    | undefined;
  const supervisor = await createSessionSupervisor({
    ...config,
    sessions:
      updateOptions.createSessions ??
      (() => {
        throw new Error("Runner session core is missing.");
      }),
    build: embeddedBuild,
    streamHelper: updateOptions.streamHelper,
    resolveBins,
    env,
    workspaces: new Set(configuredHandles),
    asWorkload,
    githubCredentialHelper: async () =>
      githubCredentialHelper(await tools.resolve("gh")),
    async probeCheckoutGit(cwd) {
      const { stdout } = await execute(
        setpriv,
        [...childArgs, ...self("runner-worker"), "git-context", cwd],
        { env, timeout: 20_000, maxBuffer: 512 * 1024 }
      );
      return JSON.parse(stdout);
    },
    async observeCheckout(cwd, scratch, policyOnly) {
      const { stdout } = await execute(
        setpriv,
        [
          ...childArgs,
          ...self("runner-worker"),
          "observe",
          cwd,
          ...(scratch ? ["--scratch"] : []),
          ...(policyOnly ? ["--policy-only"] : []),
        ],
        { env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }
      );
      return JSON.parse(stdout);
    },
    async prepareDependencies(cwd) {
      await execute(
        setpriv,
        workloadLogin([...self("runner-prepare-dependencies"), cwd]),
        {
          env: { ...env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
          timeout: 135_000,
          maxBuffer: 8_192,
        }
      );
      return true;
    },
    hostCommand: (dir) => {
      admission.assertMayStartProcess();
      return [setpriv, ...workloadLogin([...hostCommand(), "--state", dir])];
    },
    mayStartProcess: () => admission.mayStartProcess(),
    async resumePreparedCheckout(agentId) {
      if (!(await workspacePreparation?.hasReceipt(agentId))) return null;
      const binding = await workspacePreparation!.call(
        "workspace.resume",
        { session: sessionFromWire(agentId) },
        () => {}
      );
      if (!binding) throw new Error("The prepared checkout is unavailable.");
      return binding;
    },
    removePreparedCheckout: (session) =>
      workspacePreparation?.remove(session) ?? Promise.resolve(false),
  });
  workspacePreparation = managedWorkspace
    ? await updateOptions.createWorkspacePreparation?.({
        state: supervisor.stateDirectory,
        ids: {
          supervisor: process.getuid!(),
          uid: config.uid,
          gid: config.gid,
        },
        asWorkload,
        async step(op, args) {
          const worker = workloadLogin([...self("runner-worker"), op]);
          const output = await runCheckoutWorker(
            worker,
            await checkoutGitEnv(),
            JSON.stringify(args),
            AbortSignal.timeout(
              op === "workspace.installDependencies" ? 135_000 : 90_000
            )
          );
          const reply = JSON.parse(output);
          if (runnerError.check(reply?.error))
            throw new RunnerCallError(reply.error);
          if (!reply || !Object.hasOwn(reply, "data"))
            throw new Error("Invalid workspace worker reply.");
          return reply.data;
        },
      })
    : undefined;
  const updates = createRunnerUpdateAgent({
    identity:
      updateOptions.updateIdentity === undefined
        ? await detectSelfUpdate(updateLayout)
        : updateOptions.updateIdentity,
    admission,
    updater:
      updateOptions.updater ??
      systemdRunnerUpdater(
        updateLayout,
        await trialHelperAvailable(updateLayout)
      ),
    inspect: (candidate) => supervisor.inspectHandoff(candidate),
  });

  const nextDelay = runnerReconnectDelay();
  while (true) {
    const connectedMs = await new Promise<number>((finished) => {
      let connectedAt: number | undefined;
      const connection = new AbortController();
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
        // Engine probes start CLIs; skip them while the update fence holds.
        const ticket = admission.admit(60_000);
        if (!ticket) return;
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
          ticket.release();
        }
      };
      const checkoutCommands = new Map<string, AbortController>();
      let legacyCheckoutCommands = 0;
      let acceptsCheckoutExecStream = false;
      let acceptsCheckoutReadStream = false;
      let acceptsTerminalOpenStream = false;
      const watches = new Map<string, () => void>();
      const sharedWatches = new SharedCheckoutWatches((cwd, changed, closed) =>
        childWatch(
          spawn(
            setpriv,
            [...childArgs, ...self("runner-worker"), "watch", cwd],
            { env, stdio: ["pipe", "pipe", "pipe"] }
          ),
          changed,
          closed
        )
      );
      const channels = new Map<string, Duplex>();
      const terminals = new Map<string, symbol>();
      const streamedTerminals = new Map<
        string,
        {
          agentId: string;
          workspace: string;
          controller: AbortController;
        }
      >();
      function closeSessionTerminals(agentId: string, workspace: string) {
        for (const terminal of streamedTerminals.values()) {
          if (terminal.agentId === agentId && terminal.workspace === workspace)
            terminal.controller.abort();
        }
      }
      const timeout = setTimeout(() => socket.destroy(), 5000);
      socket.on("error", (error: Error) =>
        console.error("Runner transport:", error.message)
      );
      socket.on("close", () => {
        connection.abort();
        updateConnection?.close();
        // No reply can flush now; admitted work still counts until it settles.
        for (const flushed of [...awaitingReply.values()]) flushed();
        awaitingReply.clear();
        for (const close of watches.values()) close();
        watches.clear();
        clearTimeout(timeout);
        clearInterval(healthInterval);
        terminals.clear();
        for (const channel of channels.values()) channel.destroy();
        finished(
          connectedAt === undefined ? 0 : performance.now() - connectedAt
        );
      });
      // Admitted requests keep the update fence waiting until their first
      // reply has been handed to the transport.
      const awaitingReply = new Map<string, () => void>();
      const replied = new Set<string>();
      const safeSend = (frame: RunnerFrame) => {
        const flushed =
          frame.type === "result" ? awaitingReply.get(frame.id) : undefined;
        if (frame.type === "result" && flushed) {
          awaitingReply.delete(frame.id);
          replied.add(frame.id);
        }
        if (!socket.destroyed) {
          try {
            send(frame, flushed && (() => flushed()));
            return;
          } catch {
            socket.destroy();
          }
        }
        flushed?.();
      };
      function admitted(id: string, command: Command) {
        if (FENCE_EXEMPT.has(command.kind)) return () => {};
        const ticket = admission.admit(runnerReplyTimeoutMs(command));
        if (!ticket) return null;
        let settled = false;
        let flushed = false;
        const done = () => {
          if (settled && flushed) {
            replied.delete(id);
            ticket.release();
          }
        };
        awaitingReply.set(id, () => {
          flushed = true;
          done();
        });
        return () => {
          settled = true;
          // A request that ended without replying (its channel was closed
          // first) has nothing to flush, unless a terminal will still reply.
          if (
            !replied.has(id) &&
            awaitingReply.has(id) &&
            !(command.kind === "openTerminal" && channels.has(id))
          ) {
            awaitingReply.delete(id);
            flushed = true;
          }
          done();
        };
      }
      let updateConnection: ReturnType<typeof updates.connect> | undefined;
      let advert: ReturnType<typeof updates.advert>;

      /** A streamed delivery's bytes, buffered only within the stream window. */
      function receiveIncoming(streamId: string) {
        const controller = new AbortController();
        const body = new PassThrough();
        const done = streams.receive(streamId, body, controller.signal);
        done.catch(() => {});
        return {
          body,
          done,
          abort: () => controller.abort(),
        };
      }

      async function request(id: string, command: Command) {
        if (!isOpaqueId(id)) throw new Error("Invalid runner request ID");
        if (socket.destroyed) return;
        if (command.kind === "engine") {
          if (isEngineCapabilityOperation(command.operation)) {
            if (
              !(managedWorkspace
                ? command.workspace === MANAGED_WORKSPACE
                : configuredHandles.includes(command.workspace))
            ) {
              throw new Error("Unknown runner workspace.");
            }
            const ack = await engineCapability(
              command.operation,
              connection.signal
            );
            safeSend({ type: "result", id, value: JSON.stringify(ack) });
            return;
          }
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
        if (command.kind === "github") {
          try {
            const operation = command.operation;
            // Dispatch's refresher reads pull requests itself (T32).
            if (operation.type === "watchPullRequests")
              throw new Error("Pull request watches are not served.");
            const value = await github.handle(operation, connection.signal);
            safeSend({ type: "result", id, value: JSON.stringify(value) });
          } catch {
            safeSend({
              type: "result",
              id,
              error: "Runner GitHub operation failed.",
            });
          }
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
          await supervisor.launch(
            command,
            target?.cwd,
            command.launch.prepareWorkspace
              ? (progress) =>
                  safeSend({ type: "launch_progress", id, progress })
              : undefined
          );
          result(true);
          return;
        }
        if (socket.destroyed) return;
        switch (command.kind) {
          case "gitQuery": {
            const { op, request } = command.operation;
            const { target: gitTarget } = request;
            const gitEnv = await checkoutGitEnv();
            const run = (cwd?: string) =>
              runCheckoutWorker(
                workloadLogin([
                  ...self("runner-worker"),
                  op,
                  ...(cwd ? [cwd] : []),
                ]),
                gitEnv,
                JSON.stringify(request),
                AbortSignal.any([
                  connection.signal,
                  AbortSignal.timeout(20_000),
                ])
              );
            if (
              "session" in gitTarget &&
              gitTarget.session !== sessionFromWire(agentId)
            )
              throw new Error("Invalid Git query binding.");
            const value =
              "session" in gitTarget
                ? await supervisor.withCommandCheckout(
                    agentId,
                    workspace,
                    gitTarget.checkout === "current" || !gitTarget.checkout
                      ? "effective"
                      : gitTarget.checkout,
                    target?.cwd,
                    connection.signal,
                    run
                  )
                : await run(
                    "path" in gitTarget
                      ? displayPath(gitTarget.path)
                      : undefined
                  );
            result(
              value ??
                JSON.stringify({
                  error: {
                    code: "not_found",
                    message: "Checkout unavailable.",
                  },
                })
            );
            break;
          }
          case "workspacePrepare":
          case "workspaceResume": {
            const emit = (event: unknown) => {
              const progress = parseLaunchProgress({
                type: "launch_progress",
                id,
                progress: event,
              });
              if (progress) safeSend(progress);
            };
            try {
              if (!managed || !workspacePreparation)
                throw new RunnerCallError({
                  code: "unsupported",
                  message: "This runner does not serve workspace preparation.",
                });
              const session = sessionFromWire(agentId);
              const prepare =
                command.kind === "workspacePrepare"
                  ? { ...command.operation, session }
                  : undefined;
              const preparation = workspacePreparation;
              const source = prepare?.source;
              const data = await supervisor.withWorkspacePreparation(
                agentId,
                prepare !== undefined,
                async (readLegacy) => {
                  if (await preparation.legacy(agentId)) {
                    const binding = await readLegacy(prepare);
                    emit({ phase: "ready" });
                    return binding;
                  }
                  return prepare
                    ? preparation.call("workspace.prepare", prepare, emit)
                    : preparation.call("workspace.resume", { session }, emit);
                },
                source && "session" in source
                  ? sessionToWire(source.session)
                  : undefined
              );
              result(JSON.stringify({ data }));
            } catch (error) {
              result(
                JSON.stringify({
                  error:
                    error instanceof RunnerCallError
                      ? {
                          code:
                            command.kind === "workspaceResume" &&
                            error.code === "forbidden"
                              ? "conflict"
                              : error.code,
                          message: error.message,
                          details: error.details,
                        }
                      : {
                          code: "failed",
                          message: "Workspace preparation failed.",
                        },
                })
              );
            }
            break;
          }
          case "checkoutCommand": {
            const operation = command.operation;
            const execution =
              operation.kind === "run" ? operation.execution : undefined;
            const legacy = !acceptsCheckoutExecStream;
            if (execution && legacy)
              throw new Error("Checkout exec stream was not negotiated.");
            if (
              checkoutCommands.has(id) ||
              (legacy && legacyCheckoutCommands >= 32)
            )
              throw new Error(
                "Too many checkout commands or duplicate request ID."
              );
            const controller = new AbortController();
            checkoutCommands.set(id, controller);
            if (legacy) legacyCheckoutCommands++;
            const timeoutMs = execution
              ? execution.timeoutMs
              : checkoutCommandTimeoutMs(operation.checkout);
            let timedOut = false;
            const cancelDeadline =
              timeoutMs === null
                ? undefined
                : scheduleDeadline(timeoutMs, () => {
                    const message = `Runner checkout command timed out after ${timeoutMs / 1000} seconds.`;
                    if (execution) {
                      timedOut = true;
                      safeSend({
                        type: "result",
                        id,
                        code: "timeout",
                        error: message,
                      });
                    }
                    controller.abort(new Error(message));
                  });
            const signal = AbortSignal.any([
              connection.signal,
              controller.signal,
            ]);
            try {
              const value = await supervisor.withCommandCheckout(
                agentId,
                workspace,
                operation.checkout,
                target?.cwd,
                signal,
                async (cwd, configuredRoot) => {
                  const args = [
                    ...childArgs,
                    ...self("runner-checkout-command"),
                    cwd,
                    agentId,
                    ...(configuredRoot ? [configuredRoot] : []),
                  ];
                  const input = JSON.stringify(operation);
                  if (!execution)
                    return runCheckoutWorker(args, env, input, signal);
                  if (execution.shell === "direct") {
                    if (!configuredRoot) args.push("");
                    args.push(await loginPath());
                  }
                  return streamCheckoutWorker(
                    [setpriv, ...args],
                    env,
                    input,
                    execution,
                    streams,
                    signal
                  );
                }
              );
              if (value === null && operation.kind === "run") {
                const message = "The moved checkout is no longer selected.";
                if (execution)
                  throw new RunnerCallError({ code: "stale", message });
                throw new Error(message);
              }
              result(value ?? "null");
            } catch (error) {
              if (timedOut) break;
              if (
                !execution ||
                !(error instanceof RunnerCallError) ||
                error.code !== "stale"
              )
                throw error;
              safeSend({
                type: "result",
                id,
                code: "stale",
                error: error.message,
              });
            } finally {
              cancelDeadline?.();
              if (legacy) legacyCheckoutCommands--;
              checkoutCommands.delete(id);
            }
            break;
          }
          case "sessionFile": {
            const streamId = command.operation.streamId;
            // Register a streamed delivery's sink before anything awaits: the
            // controller opens the stream right after this request's frame.
            const incoming =
              command.operation.kind === "deliver" && streamId !== undefined
                ? receiveIncoming(streamId)
                : undefined;
            const value = await supervisor
              .sessionFile(
                agentId,
                workspace,
                command.operation,
                async (kind, root, name, data) => {
                  const [bin, args] = sessionFileCommand(
                    config.uid,
                    config.gid,
                    self("runner-session-file"),
                    kind,
                    root,
                    name
                  );
                  if (kind === "receive") {
                    if (!incoming) throw new Error("Missing file stream ID.");
                    const child = spawn(bin, args, {
                      env,
                      signal: connection.signal,
                      stdio: ["pipe", "ignore", "pipe"],
                    });
                    let stderr = "";
                    child.stderr
                      .setEncoding("utf8")
                      .on("data", (chunk: string) => {
                        stderr = (stderr + chunk).slice(0, 256);
                      });
                    child.stdin.on("error", () => {});
                    const exited = new Promise<void>((resolve, reject) => {
                      child.once("error", reject);
                      child.once("close", (status) => {
                        if (status === 0) resolve();
                        else
                          reject(
                            new Error(
                              stderr.trim() || "Runner file transfer failed."
                            )
                          );
                      });
                    });
                    incoming.body.pipe(child.stdin);
                    try {
                      await Promise.all([incoming.done, exited]);
                    } finally {
                      if (child.exitCode === null && child.signalCode === null)
                        child.kill();
                    }
                    return "";
                  }
                  if (kind === "stream") {
                    if (streamId === undefined)
                      throw new Error("Missing file stream ID.");
                    const child = spawn(bin, args, {
                      env,
                      signal: connection.signal,
                      stdio: ["ignore", "pipe", "pipe"],
                    });
                    let stderr = "";
                    child.stderr
                      .setEncoding("utf8")
                      .on("data", (chunk: string) => {
                        stderr = (stderr + chunk).slice(0, 256);
                      });
                    const exited = new Promise<void>((resolve, reject) => {
                      child.once("error", reject);
                      child.once("close", (status) => {
                        if (status === 0) resolve();
                        else
                          reject(
                            new Error(
                              stderr.trim() || "Runner file transfer failed."
                            )
                          );
                      });
                    });
                    try {
                      await Promise.all([
                        streams.send(streamId, child.stdout, connection.signal),
                        exited,
                      ]);
                    } finally {
                      if (child.exitCode === null && child.signalCode === null)
                        child.kill();
                    }
                    return "";
                  }
                  const child = execute(bin, args, {
                    env,
                    timeout: 15_000,
                    signal: connection.signal,
                    maxBuffer: MAX_SESSION_FILE_BASE64 + 1024,
                  });
                  child.child.stdin?.on("error", () => {});
                  child.child.stdin?.end(data);
                  try {
                    return (await child).stdout;
                  } catch (error) {
                    throw new Error(
                      (error as { stderr?: string }).stderr
                        ?.trim()
                        .slice(0, 256) || "Runner file transfer failed."
                    );
                  }
                },
                target?.cwd
              )
              .finally(() => incoming?.abort());
            result(
              streamId === undefined || command.operation.kind === "deliver"
                ? value
                : true
            );
            break;
          }
          case "workspaceRelease": {
            const removed = await supervisor.releaseWorkspace(
              agentId,
              workspace,
              async (legacySource) => {
                if (!workspacePreparation)
                  throw new Error(
                    "This runner does not serve workspace release."
                  );
                if (await workspacePreparation.legacy(agentId))
                  return workspacePreparation.releaseLegacy(
                    agentId,
                    legacySource,
                    command.operation
                  );
                const reply = await workspacePreparation.call(
                  "workspace.release",
                  { ...command.operation, session: sessionFromWire(agentId) },
                  () => {}
                );
                return reply.removed;
              }
            );
            if (removed) closeSessionTerminals(agentId, workspace);
            result(JSON.stringify({ removed }));
            break;
          }
          case "checkoutRelease": {
            const observation = await supervisor.checkoutRelease(
              agentId,
              workspace,
              command.operation
            );
            if (observation === "released" || observation === "retained")
              closeSessionTerminals(agentId, workspace);
            result(
              typeof observation === "string"
                ? observation
                : JSON.stringify(observation)
            );
            break;
          }
          case "sessionCheckout":
            result(
              JSON.stringify(
                command.operation.kind === "context"
                  ? await supervisor.gitContext(
                      agentId,
                      workspace,
                      command.operation,
                      target?.cwd
                    )
                  : await supervisor.sessionCheckout(
                      agentId,
                      workspace,
                      command.operation,
                      target?.cwd
                    )
              )
            );
            break;
          case "openTerminal": {
            if (command.stream) {
              if (!acceptsTerminalOpenStream)
                throw new Error("Terminal streams were not negotiated.");
              const { input, output, cols, rows } = command.stream;
              if (
                streamedTerminals.has(id) ||
                streams.has(input) ||
                streams.has(output)
              )
                throw new Error("Duplicate terminal channel.");
              const controller = new AbortController();
              const signal = AbortSignal.any([
                connection.signal,
                controller.signal,
              ]);
              streamedTerminals.set(id, { agentId, workspace, controller });

              // Register before looking up the checkout so that a cancelled
              // open can also stop a worker whose readiness is still pending.
              const events = new PassThrough();
              const sent = streams.send(output, events, signal, {
                stall: "blocked",
              });
              void sent.then(
                () => controller.abort(),
                () => controller.abort()
              );
              let handedOff = false;
              try {
                const cwd = await supervisor.checkoutDirectory(
                  agentId,
                  workspace,
                  target?.cwd
                );
                signal.throwIfAborted();
                const child = startTerminalWorker(
                  [setpriv, ...childArgs],
                  [...self("runner-terminal"), cwd, String(cols), String(rows)],
                  terminalEnvironment(env)
                );
                const { stdin, stdout, stderr: readiness } = child;
                const stop = () => {
                  stdin.destroy();
                  stdout.destroy();
                  readiness.destroy();
                  child.kill();
                };
                signal.addEventListener("abort", stop, { once: true });
                child.once("error", () => controller.abort());
                child.once("close", () => {
                  signal.removeEventListener("abort", stop);
                  streamedTerminals.delete(id);
                });
                stdin.on("error", () => {}); // The output half may still have an exit event.
                stdout.on("error", () => controller.abort());
                // A child can exit before it consumes the next input frame.
                // Keep that pipe's failure from masking its final output.
                const controls = new Writable({
                  write(chunk, _encoding, done) {
                    if (stdin.destroyed) return done();
                    stdin.write(chunk, () => done());
                  },
                  destroy(error, done) {
                    stdin.destroy();
                    done(error);
                  },
                  final(done) {
                    stdin.end(done);
                  },
                });
                void streams
                  .receive(input, controls, signal, { stall: false })
                  .catch(() => {
                    stdin.destroy();
                  });
                let ready = "";
                for await (const chunk of readiness) ready += chunk.toString();
                signal.throwIfAborted();
                if (!ready || !isTerminalInfo(JSON.parse(ready)))
                  throw new Error(
                    "The runner could not start a terminal in this checkout."
                  );

                result(ready);
                stdout.pipe(events);
                const unfenced = admission.onTerminal(() => {
                  streams.interrupt(output, "fenced");
                  controller.abort();
                });
                void sent.finally(unfenced).catch(() => {});
                handedOff = true;
              } finally {
                if (!handedOff) {
                  controller.abort();
                  streamedTerminals.delete(id);
                }
              }
              break;
            }
            if (terminals.size >= 16 || terminals.has(id) || channels.has(id))
              throw new Error(
                "Runner terminal limit reached or duplicate channel."
              );
            const reservation = Symbol();
            terminals.set(id, reservation);
            try {
              const cwd = await supervisor.checkoutDirectory(
                agentId,
                workspace,
                target?.cwd
              );
              if (terminals.get(id) !== reservation || socket.destroyed) return;
              const child = spawn(
                setpriv,
                [...childArgs, ...self("runner-terminal"), cwd],
                {
                  env: terminalEnvironment(env),
                  stdio: ["pipe", "pipe", "ignore"],
                }
              );
              child.on("error", () => channel.destroy());
              const channel = Duplex.from({
                readable: child.stdout,
                writable: child.stdin,
              });
              channels.set(id, channel);
              let ready = false;
              channel.on("error", () => channel.destroy());
              // The update fence closes terminals with an explicit reason.
              const unfenced = admission.onTerminal(() => {
                if (ready)
                  safeSend({
                    type: "data",
                    id,
                    data: Buffer.from(
                      JSON.stringify({
                        type: "error",
                        message: TERMINAL_UPDATE_MESSAGE,
                        reason: "update",
                      }) + "\n"
                    ).toString("base64"),
                  });
                channel.destroy();
              });
              channel.once("close", () => {
                unfenced();
                child.kill();
                terminals.delete(id);
                channels.delete(id);
                if (!ready)
                  safeSend({
                    type: "result",
                    id,
                    error:
                      "The runner could not start a terminal in this checkout.",
                  });
                safeSend({ type: "close", id });
              });
              wireFrames<unknown>(
                channel,
                (event) => {
                  if (
                    !ready &&
                    event &&
                    typeof event === "object" &&
                    "type" in event &&
                    event.type === "ready" &&
                    "info" in event &&
                    isTerminalInfo(event.info)
                  ) {
                    ready = true;
                    result(JSON.stringify(event.info));
                  } else if (ready && isTerminalEvent(event)) {
                    safeSend({
                      type: "data",
                      id,
                      data: Buffer.from(JSON.stringify(event) + "\n").toString(
                        "base64"
                      ),
                    });
                  } else channel.destroy();
                },
                MAX_TERMINAL_FRAME_LENGTH
              );
            } catch (error) {
              if (terminals.get(id) !== reservation) return;
              terminals.delete(id);
              throw error;
            }
            break;
          }
          case "watchCheckout": {
            const cwd = await supervisor.checkoutDirectory(
              agentId,
              workspace,
              target?.cwd
            );
            if (socket.destroyed) return;
            if (watches.size >= 512)
              throw new Error("Too many open checkout watches.");
            watches.set(
              id,
              sharedWatches.subscribe(
                cwd,
                () => safeSend({ type: "data", id, data: "MQ==" }),
                () => {
                  watches.delete(id);
                  safeSend({ type: "close", id });
                }
              )
            );
            result(true);
            break;
          }
          case "checkoutRead": {
            if (!acceptsCheckoutReadStream)
              throw new Error("Checkout read stream was not negotiated.");
            const controller = new AbortController();
            const signal = AbortSignal.any([
              connection.signal,
              controller.signal,
            ]);
            const { streamId, ...read } = command.operation;
            let child: ReturnType<typeof spawn> | undefined;
            let exited = false;
            async function* output() {
              const cwd = await supervisor.checkoutDirectory(
                agentId,
                workspace,
                target?.cwd
              );
              signal.throwIfAborted();
              const worker = spawn(
                setpriv,
                [...childArgs, ...self("runner-worker"), "read", cwd],
                {
                  env: {
                    ...env,
                    GIT_TERMINAL_PROMPT: "0",
                    GH_PROMPT_DISABLED: "1",
                  },
                  detached: true,
                  stdio: ["pipe", "pipe", "ignore"],
                }
              );
              child = worker;
              const status = new Promise<boolean>((resolve) => {
                worker.once("error", () => resolve(false));
                worker.once("close", (code) => {
                  exited = true;
                  resolve(code === 0);
                });
              });
              worker.stdin.on("error", () => {});
              worker.stdin.end(JSON.stringify(read));
              yield* worker.stdout;
              if (!(await status))
                throw new Error("The checkout read worker failed.");
            }
            try {
              await streams.send(
                streamId,
                Readable.from(output(), { objectMode: false }),
                signal,
                {
                  stall: "blocked",
                }
              );
              result(true);
            } finally {
              controller.abort();
              if (!exited && child?.pid) {
                try {
                  process.kill(-child.pid, "SIGKILL");
                } catch {
                  // The workload may already have exited.
                }
              }
            }
            break;
          }
          case "viewCheckout":
          case "inspectCheckout": {
            const cwd = await supervisor.checkoutDirectory(
              agentId,
              workspace,
              target?.cwd
            );
            const child = execute(
              setpriv,
              [
                ...childArgs,
                ...self("runner-worker"),
                command.kind === "viewCheckout" ? "view" : "inspect",
                cwd,
                ...(managed ? ["--managed"] : []),
              ],
              {
                env: {
                  ...env,
                  GIT_TERMINAL_PROMPT: "0",
                  GH_PROMPT_DISABLED: "1",
                },
                timeout: 90_000,
                maxBuffer:
                  command.kind === "viewCheckout"
                    ? MAX_CHECKOUT_VIEW_BYTES
                    : 4 * 1024 * 1024,
              }
            );
            child.child.stdin?.on("error", () => {}); // execFile reports early child failure.
            // The worker can publish a cached reply while it finishes a
            // bounded background refresh under the workload identity.
            let sent = false;
            if (
              command.kind === "inspectCheckout" &&
              command.query.kind === "defaultBranchFiles" &&
              !command.query.waitForRefresh
            ) {
              const chunks: Buffer[] = [];
              let bytes = 0;
              child.child.stdout?.on("data", (data: string | Buffer) => {
                if (sent) return;
                const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
                bytes += chunk.length;
                if (bytes > 4 * 1024 * 1024) return;
                chunks.push(chunk);
                if (chunk[chunk.length - 1] === 10) {
                  sent = true;
                  result(Buffer.concat(chunks).toString("utf8").trimEnd());
                }
              });
            }
            child.child.stdin?.end(JSON.stringify(command.query));
            try {
              const { stdout } = await child;
              if (!sent) result(stdout.trimEnd());
            } catch (error) {
              if (sent) break;
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
          case "stop": {
            const stopped = await supervisor.stop(
              agentId,
              workspace,
              command.force,
              command.expectedLaunchId
            );
            if (stopped !== false) closeSessionTerminals(agentId, workspace);
            result(true);
            break;
          }
          case "discard":
            await supervisor.discard(agentId, workspace);
            closeSessionTerminals(agentId, workspace);
            result(true);
            break;
          case "log":
            result(await supervisor.log(agentId, workspace));
            break;
          // Older controllers can still send this configured workspace operation.
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
              workloadLogin([bin, ...args]),
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

      const send = wireFrames<unknown, RunnerOutput>(socket, (value) => {
        if (socket.destroyed) return;
        if (acceptsStreams(value) && connectedAt !== undefined) {
          acceptsCheckoutReadStream ||= value.checkoutReadStream === true;
          acceptsCheckoutExecStream ||= value.checkoutExecStream === true;
          acceptsTerminalOpenStream ||= value.terminalOpenStream === true;
          streams.enable();
          return;
        }
        if (streams.handle(value)) return;
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
          // Admission is decided synchronously, in frame order.
          const settled = admitted(frame.id, frame.command);
          if (!settled) {
            safeSend({
              type: "result",
              id: frame.id,
              code: "update-fenced",
              error: UPDATE_FENCED_MESSAGE,
            });
            return;
          }
          void request(frame.id, frame.command)
            .catch((error) =>
              safeSend({
                type: "result",
                id: frame.id,
                error:
                  error instanceof Error
                    ? error.message
                    : "Runner command failed",
              })
            )
            .finally(settled);
        } else if (UPDATE_SERVICE_FRAME_TYPES.has(frame.type)) {
          // Only a runner that advertised the capability accepts these.
          if (!advert || !updateConnection) return socket.destroy();
          void updateConnection.receive(
            frame as Parameters<typeof updateConnection.receive>[0]
          );
        } else if (frame.type === "cancel_checkout_command") {
          checkoutCommands
            .get(frame.id)
            ?.abort(new Error("Checkout command cancelled."));
        } else if (frame.type === "data") {
          const channel = channels.get(frame.id);
          if (
            channel &&
            terminals.has(frame.id) &&
            (channel.writableLength > 128 * 1024 ||
              frame.data.length > 256 * 1024)
          )
            channel.destroy();
          else if (channel && channel.writableLength > 32 * 1024 * 1024)
            channel.destroy();
          else channel?.write(Buffer.from(frame.data, "base64"));
        } else if (frame.type === "close") {
          watches.get(frame.id)?.();
          watches.delete(frame.id);
          const channel = channels.get(frame.id);
          if (channel) channel.destroy();
          else terminals.delete(frame.id);
        } else socket.destroy();
      });
      const streams = new FlowStreams(socket, send);
      socket.once("secureConnect", () => {
        advert = updates.advert();
        connectedAt = performance.now();
        clearTimeout(timeout);
        safeSend({
          type: "ready",
          version: RUNNER_WIRE_VERSION,
          health: true,
          streamCredit: true,
          workspaces: managedWorkspace
            ? [MANAGED_WORKSPACE]
            : configuredHandles,
          ...(managedWorkspace ? { managedWorkspace: true } : {}),
          engineManagement: true,
          engineCapabilities: true,
          githubManagement: true,
          repositoryPicker: true,
          pullRequestStatus: true,
          pullRequestEvidence: true,
          checkoutInspection: true,
          checkoutMetadata: true,
          checkoutCommands: true,
          checkoutExecStream: true,
          checkoutReadStream: true,
          ...(typeof Bun !== "undefined" && typeof Bun.Terminal === "function"
            ? { terminals: true, terminalOpenStream: true }
            : {}),
          defaultBranchFiles: true,
          workspacePreparation: true,
          gitQueries: true,
          ...(workspacePreparation && {
            workspacePrepare: true,
            preparedLaunch: true,
            sessionWorkspaceSource: true,
          }),
          ...((workspacePreparation || !managedWorkspace) && {
            workspaceRelease: true,
          }),
          sessionCheckout: true,
          checkoutRelease: true,
          sessionFiles: true,
          filesGetStream: true,
          filesPutStream: true,
          checkoutViews: true,
          sharedWorktree: true,
          launchReconcile: true,
          scopedStop: true,
          ...(advert ? { selfUpdate: advert } : {}),
        });
        updateConnection = updates.connect((frame) => {
          safeSend(frame);
          // A commit supersedes what this connection's first sample said.
          if (frame.phase === "confirmed" && healthInterval)
            void reportHealth();
        });
      });
    }).catch((error) => {
      supervisor.close();
      throw error;
    });
    await new Promise((resolve) => setTimeout(resolve, nextDelay(connectedMs)));
  }
}
