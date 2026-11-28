import { X509Certificate } from "node:crypto";
import { serveOperationSocket } from "../../../local/socket-server.js";
import { enrolledSessions } from "./session-operations.js";
import { enrolledWorkspace } from "./workspace-operations.js";
import { enrolledFiles, workloadFileWorker } from "./file-operations.js";
import { enrolledChannels } from "./channel-operations.js";
import { enrolledCheckouts, enrolledCommand } from "./checkout-operations.js";
import {
  enrolledEngineCalls,
  enrolledGitHubCalls,
} from "./machine-operations.js";
import { enrolledAdmission } from "./operation-admission.js";
import { enrolledUpdates } from "./update-operations.js";
import { frameWriter } from "@dispatch/runner-client/v1/node";
import { runnerIdFromWire } from "@dispatch/runner-protocol/contract";
import type { UpdateStatusFrame } from "@dispatch/runner-protocol";
import type { WorkspacePreparationPort } from "./workspace-operations.js";
import type { BuildIdentity } from "@dispatch/runner-protocol/build-identity";
import { childProcessEnv } from "../../shared/process/child-environment.js";
import { executionArgs, setpriv } from "./workload-identity.js";
import { runnerHealthSampler } from "./health.js";
import { SharedCheckoutWatches, childWatch } from "../checkout-watch.js";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import process from "node:process";
import { connect } from "node:tls";
import { Readable } from "node:stream";
import { checkoutWorkerStderr } from "../checkout-command-executor.js";
import { terminalEnvironment } from "../../terminal/pty.js";
import { promisify } from "node:util";
import type { HostLaunch } from "@dispatch/runner-protocol/host";
import type { WorkloadCommand } from "./session-storage.js";
import {
  createSessionSupervisor,
  type SessionCoreFactory,
} from "./session-supervisor.js";
import { hostCommand, selfCommand } from "@dispatch/runner/host/host-command";
import {
  RunnerCallError,
  runnerError,
  sessionFromWire,
  type Req,
} from "@dispatch/runner-protocol/contract";
import { UpdateAdmission, type FenceStore } from "./update-admission.js";
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
  RUNNER_WIRE_VERSION,
  isCheckoutCommandStatus,
  MAX_CHECKOUT_COMMAND_REPLY_BYTES,
  type RunnerEngine,
} from "@dispatch/runner-protocol";
import { GitHubRunnerExecutor } from "./github-runner-executor.js";
import {
  WorkloadTools,
  cacheWorkloadPath,
  workloadPathProbe,
  githubCredentialHelper,
  githubCredentialKey,
  missingExecutable,
  systemTools,
  enterDirectory,
  workloadLoginCommand,
  workloadToolLookup,
} from "./workload-tools.js";
import {
  EngineRunnerExecutor,
  type ManagedCommand,
} from "./engine-runner-executor.js";
export { runnerStorageKey } from "./session-supervisor.js";

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
export async function streamCommandOutput(
  command: [string, ...string[]],
  env: NodeJS.ProcessEnv,
  input: string,
  maxOutput: number | null,
  sendOutput: (
    name: "stdout" | "stderr",
    source: Readable,
    signal: AbortSignal
  ) => Promise<void>,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  const child = startCheckoutWorker(command, env, input);
  let truncated = false;
  async function* limitOutput(source: AsyncIterable<Buffer>) {
    let remaining = maxOutput ?? Infinity;
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
  const send = (name: "stdout" | "stderr", source: AsyncIterable<Buffer>) =>
    sendOutput(
      name,
      Readable.from(limitOutput(source), { objectMode: false }),
      transfer
    );
  // Either output can finish before the worker exits. Cancellation must
  // release the checkout even if neither transfer is still listening.
  let completed = false;
  try {
    const [workerStatus] = await waitForCheckoutWorker(
      signal,
      Promise.all([
        child.exited,
        send("stdout", child.stdout),
        send("stderr", stderr),
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
    return { exitCode: value.exitCode, truncated };
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

/** Test seams. Production uses the installed root updater layout. */
type WorkspacePreparationFactory = (options: {
  state: string;
  ids: { supervisor: number; uid: number; gid: number };
  asWorkload: WorkloadCommand;
  step: (op: string, args: unknown[]) => Promise<unknown>;
}) => Promise<
  WorkspacePreparationPort & {
    bindingWritten(session: string): Promise<void>;
    hasReceipt(session: string): Promise<boolean>;
    remove(session: string): Promise<boolean>;
    forget?(session: string): Promise<void>;
    /** A repository's cached clone, as a launch from that repository uses it. */
    repositoryClone?(url: string): Promise<string>;
  }
>;

export type RunnerUpdateOptions = {
  build: BuildIdentity;
  healthBuild: { version: string; revision: string | null };
  updateLayout?: RunnerUpdateLayout;
  fenceStore?: FenceStore;
  updater?: RunnerUpdater;
  /** Undefined detects the installed identity; null disables the capability. */
  updateIdentity?: UpdateIdentity | null;
  terminalGraceMs?: number;
  createWorkspacePreparation?: WorkspacePreparationFactory;
  /** The runner's session core; the supervisor needs it to start. */
  createSessions?: SessionCoreFactory;
  streamHelper: string;
};

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
  updateOptions: RunnerUpdateOptions
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
    path.dirname(updateLayout.installed),
    updateOptions.healthBuild
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
  // Hosts and catalog reads take an adapter override only through their bins.
  const [adapterBin, ...adapterArgs] = config.adapter ?? [];
  const bins: HostLaunch["bins"] = adapterBin
    ? { ...config.bins, adapter: { bin: adapterBin, args: adapterArgs } }
    : config.bins;
  const engineExecutor = new EngineRunnerExecutor({
    adapter: bins.adapter,
    hostCommand: () => self("runner-engine-host"),
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
  const closeEngines = () => engineExecutor.close();
  process.once("exit", closeEngines);
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
    build: updateOptions.build,
    streamHelper: updateOptions.streamHelper,
    resolveBins,
    env,
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
    hostCommand: (dir, cwd) => {
      admission.assertMayStartProcess();
      // Privilege drops first; only then does the workload enter `cwd`.
      return [
        setpriv,
        ...childArgs,
        ...enterDirectory(cwd),
        ...workloadLoginCommand(
          [...hostCommand(), "--state", dir],
          shell,
          config.home,
          config.path
        ),
      ];
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
    forgetPreparedCheckout: (session) =>
      workspacePreparation?.forget?.(session) ?? Promise.resolve(),
    bindingWritten: (agentId) =>
      workspacePreparation?.bindingWritten(agentId) ?? Promise.resolve(),
  });
  workspacePreparation = await updateOptions.createWorkspacePreparation?.({
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
  });
  const updates = createRunnerUpdateAgent({
    identity:
      updateOptions.updateIdentity === undefined
        ? await detectSelfUpdate(updateLayout, updateOptions.build)
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

  const runnerId = new X509Certificate(credentials.cert).subject.replace(
    /^CN=/,
    ""
  );
  const nextDelay = runnerReconnectDelay();
  while (true) {
    const connectedMs = await new Promise<number>((finished) => {
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
      let connectedAt: number | undefined;
      let updater: ReturnType<typeof enrolledUpdates> | undefined;
      const timeout = setTimeout(() => socket.destroy(), 5000);
      socket.on("error", (error: Error) =>
        console.error("Runner transport:", error.message)
      );
      socket.once("close", () => {
        connection.abort();
        clearTimeout(timeout);
        updater?.close();
        finished(
          connectedAt === undefined ? 0 : performance.now() - connectedAt
        );
      });
      socket.once("secureConnect", () => {
        connectedAt = performance.now();
        clearTimeout(timeout);
        const signal = connection.signal;
        const send = frameWriter<UpdateStatusFrame>(socket);
        // The authenticated controller registers the description before it
        // receives the durable outcome replayed by connect().
        let ready = false;
        const pending: UpdateStatusFrame[] = [];
        updater = enrolledUpdates(updates, (frame) => {
          if (!ready) pending.push(frame);
          else if (!socket.destroyed) send(frame);
        });
        const watches = new SharedCheckoutWatches((cwd, changed, closed) =>
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
        const channels = enrolledChannels(
          supervisor,
          watches,
          admission,
          (cwd, cols, rows) =>
            startTerminalWorker(
              [setpriv, ...childArgs],
              [...self("runner-terminal"), cwd, String(cols), String(rows)],
              terminalEnvironment(env)
            )
        );
        const sessions = enrolledSessions(supervisor, channels.closeSession);
        const checkouts = enrolledCheckouts(
          supervisor,
          {
            repositoryClone: workspacePreparation?.repositoryClone,
            run: async (op, cwd, input, active) =>
              runCheckoutWorker(
                workloadLogin([
                  ...self("runner-worker"),
                  op,
                  ...(cwd ? [cwd] : []),
                ]),
                await checkoutGitEnv(),
                JSON.stringify(input),
                active
              ),
            manifest: (cwd, id, input, active) =>
              runCheckoutWorker(
                [...childArgs, ...self("runner-checkout-command"), cwd, id],
                env,
                JSON.stringify(input),
                active
              ),
            read(cwd, input, active) {
              const worker = startCheckoutWorker(
                [setpriv, ...childArgs, ...self("runner-worker"), "read", cwd],
                { ...env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
                JSON.stringify(input)
              );
              worker.stderr.resume();
              const stop = () => stopCheckoutWorker(worker);
              active.addEventListener("abort", stop, { once: true });
              const done = worker.exited;
              void done.catch(() => {});
              async function* output() {
                let completed = false;
                try {
                  yield* worker.stdout;
                  if ((await done) !== "0")
                    throw new Error("The checkout read worker failed.");
                  completed = true;
                } finally {
                  active.removeEventListener("abort", stop);
                  if (!completed) stop();
                }
              }
              return Readable.from(output(), { objectMode: false });
            },
          },
          signal
        );
        serveOperationSocket(
          socket,
          { kind: "enrolled" },
          {
            checkoutRead: checkouts.checkoutRead,
            calls: {
              ...sessions.calls,
              ...checkouts.calls,
              ...enrolledWorkspace(
                supervisor,
                workspacePreparation,
                channels.closeSession
              ),
              ...enrolledEngineCalls(engineExecutor),
              ...enrolledGitHubCalls(github, signal),
              ...updater.calls,
              ...enrolledFiles(supervisor, (kind, root, name) =>
                workloadFileWorker(
                  config.uid,
                  config.gid,
                  self("runner-session-file"),
                  env,
                  signal
                )(kind, root, name)
              ),
              "checkout.exec": enrolledCommand(
                supervisor,
                async (cwd, id, input, output, active) =>
                  streamCommandOutput(
                    [
                      setpriv,
                      ...childArgs,
                      ...self("runner-checkout-command"),
                      cwd,
                      id,
                      ...(input.shell === "direct"
                        ? ["", await loginPath()]
                        : []),
                    ],
                    env,
                    JSON.stringify(input),
                    input.maxOutput,
                    output,
                    active
                  )
              ),
              "runner.health": async () =>
                sampleHealth(await supervisor.liveDirectories()),
              "runner.describe": () => {
                const advert = updates.advert();
                if (!ready)
                  setImmediate(() => {
                    ready = true;
                    if (!socket.destroyed)
                      for (const frame of pending.splice(0)) send(frame);
                  });
                return {
                  runnerId: runnerIdFromWire(runnerId),
                  displayName: runnerId,
                  build: {
                    version: updateOptions.build.version,
                    ...(updateOptions.build.revision && {
                      revision: updateOptions.build.revision,
                    }),
                  },
                  protocol: RUNNER_WIRE_VERSION,
                  engines: [],
                  capabilities: advert ? { selfUpdate: advert } : {},
                };
              },
            },
            opens: { ...sessions.opens, ...channels.opens },
          },
          enrolledAdmission(admission)
        );
      });
    }).catch((error) => {
      supervisor.close();
      process.removeListener("exit", closeEngines);
      engineExecutor.close();
      throw error;
    });
    await new Promise((resolve) => setTimeout(resolve, nextDelay(connectedMs)));
  }
}
