import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  type EngineHostCall,
  type EngineHostCallName,
} from "@dispatch/runner-protocol/engine-management";
import { EngineUpdateHost, installationOnWire } from "../engine-updates.js";
import {
  createPluginStatusChecker,
  isPluginAgentType,
  type PluginStatusChecker,
} from "../../shared/plugin-status.js";
import { findEngineBin } from "../engine-availability.js";
import { executionArgs, setpriv } from "./workload-identity.js";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { chown, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RunnerEngine } from "@dispatch/runner-protocol";
import {
  RunnerCallError,
  type Req,
  type Res,
} from "@dispatch/runner-protocol/contract";
import {
  RUNNER_ENGINES,
  isEngineCapabilityOperation,
  type EngineInventoryEntry,
  type EngineLoginView,
  type EngineOperation,
  type EngineOperationAck,
  type EngineOperationEvent,
  type EngineSupportedAction,
} from "@dispatch/runner-protocol/engine-management";

import type { AcpEngineId } from "../acp/engine-spec.js";
import {
  compareVersions,
  engineStatuses,
  withEngineVersions,
} from "../engine-availability.js";
import {
  EngineLogins,
  isLoginEngine,
  loginScript,
  type EngineLoginDeps,
} from "../engine-login.js";
import {
  engineUpdatePort,
  inspectInstallation,
  withEngineUpdates,
} from "../engine-updates.js";

/**
 * One engine's installation, and the install or update it offers: the half
 * of an inventory row each platform answers its own way (T29).
 */
export type EngineInstallation = {
  id: RunnerEngine;
  installed: boolean;
  version: string | null;
  actions: EngineSupportedAction[];
  detail?: string;
  issue?: string;
};

/** What an `engine.list` asked for; each part costs probes of its own. */
export type EngineListParts = {
  version: boolean;
  actions: boolean;
  signIn: boolean;
};

export type EngineWorkloadPlatform = {
  plugins?: PluginStatusChecker;
  inspectUpdate?: (
    engine: string,
    action?: "install" | "update",
    presentation?: boolean
  ) => Promise<Res<"engine.update.inspect">>;
  pluginBin?: (engine: "claude" | "codex") => Promise<string>;
  /** Every engine's installation, with only the parts asked for. */
  installations(parts: EngineListParts): Promise<EngineInstallation[]>;
  /** How this platform finds and runs an engine's CLI for a sign-in. */
  logins: EngineLoginDeps;
};

const notFound = () =>
  new RunnerCallError({ code: "not_found", message: "Sign-in not found." });

/**
 * The engine inventory (`engine.list`) and sign-in (`engine.login.*`) every
 * runner serves, the local child and enrolled runners alike: the platform
 * says what is installed and how a CLI runs; the sign-in, and which rows
 * offer it, are the same everywhere.
 */
export class EngineWorkload {
  private readonly updateHost = new EngineUpdateHost();
  private readonly plugins: PluginStatusChecker;
  private readonly logins: EngineLogins;

  constructor(private readonly platform: EngineWorkloadPlatform) {
    this.logins = new EngineLogins(platform.logins);
    this.plugins =
      platform.plugins ??
      createPluginStatusChecker({
        binFor: async (engine) =>
          platform.pluginBin
            ? await platform.pluginBin(engine)
            : ((await platform.logins.resolveBin(engine)) ?? engine),
      });
  }

  async updateInspect(
    request: Req<"engine.update.inspect">
  ): Promise<Res<"engine.update.inspect">> {
    if (!this.platform.inspectUpdate)
      throw new RunnerCallError({
        code: "unsupported",
        message: "Engine inspection unavailable.",
      });
    return this.platform.inspectUpdate(
      request.engine,
      request.action,
      request.presentation
    );
  }
  updateSpawn(request: Req<"engine.update.spawn">) {
    return this.updateHost.spawn(request);
  }
  updateRelease(request: Req<"engine.update.release">) {
    return this.updateHost.release(request);
  }
  updateProbe(request: Req<"engine.update.probe">) {
    return this.updateHost.probe(request);
  }
  operation(request: Req<"engine.operation">) {
    return this.updateHost.operation(request);
  }

  private pluginEngine(request: { engine: string; plugin: string }) {
    if (
      !isPluginAgentType(request.engine) ||
      request.plugin !== "dispatch@dispatch"
    )
      throw new RunnerCallError({
        code: "unsupported",
        message: "Plugin is unavailable.",
      });
    return request.engine;
  }
  async pluginStatus(
    request: Req<"engine.plugin.status">
  ): Promise<Res<"engine.plugin.status">> {
    const engine = this.pluginEngine(request);
    const status = await this.plugins.getStatus(engine, {
      forceRefresh: request.refresh,
    });
    return { ...status, actions: status.installed ? ["update"] : ["install"] };
  }
  async pluginApply(
    request: Req<"engine.plugin.apply">
  ): Promise<Res<"engine.plugin.apply">> {
    const engine = this.pluginEngine(request);
    const result = await this.plugins[request.action](engine);
    return {
      ...result.status,
      ranCommands: result.ranCommands,
      error: result.error,
      probeFailed: result.probeFailed,
      actions: result.status.installed ? ["update"] : ["install"],
    };
  }

  /**
   * Every engine's row. `include` asks for less (absent: everything); what
   * is left out reads as unknown and is never probed for.
   */
  async list(
    request: { include?: readonly string[] } = {}
  ): Promise<{ entries: EngineInventoryEntry[] }> {
    const parts: EngineListParts = request.include
      ? {
          version: request.include.includes("version"),
          actions: request.include.includes("actions"),
          signIn: request.include.includes("signIn"),
        }
      : { version: true, actions: true, signIn: true };
    const installations = await this.platform.installations(parts);
    const entries = await Promise.all(
      installations.map(async (installation) => {
        const { id, installed } = installation;
        let signedIn: boolean | null = null;
        let detail = installation.detail;
        if (parts.signIn && installed && isLoginEngine(id)) {
          const status = await this.logins.status(id);
          signedIn = status.signedIn;
          detail = status.detail;
        }
        const actions = parts.actions ? [...installation.actions] : [];
        if (parts.actions && installed && isLoginEngine(id))
          actions.push("login", "login_cancel");
        return {
          id,
          label: LABELS[id],
          installed,
          signedIn,
          version: parts.version ? installation.version : null,
          ...(detail ? { detail } : {}),
          ...(installation.issue ? { issue: installation.issue } : {}),
          actions,
        };
      })
    );
    return { entries };
  }

  /**
   * Start a sign-in, or join the one under way. `onUpdate` hears of the
   * login as soon as it exists, before its link.
   */
  async loginStart(
    request: Pick<Req<"engine.login.start">, "engine"> & { restart?: boolean },
    onUpdate?: (login: EngineLoginView) => void
  ): Promise<EngineLoginView> {
    const engine = request.engine as RunnerEngine;
    if (!isLoginEngine(engine))
      throw new RunnerCallError({
        code: "unsupported",
        message: `${LABELS[engine] ?? engine} has no sign-in flow.`,
      });
    return this.logins.start(engine, {
      ...(request.restart !== undefined && { restart: request.restart }),
      ...(onUpdate && { onEntry: onUpdate }),
    });
  }

  async loginSubmit(request: {
    loginId: string;
    code: string;
  }): Promise<EngineLoginView> {
    const login = this.logins.submitCode(request.loginId, request.code);
    if (!login) throw notFound();
    return login;
  }

  async loginStatus(request: { loginId: string }): Promise<EngineLoginView> {
    const login = this.logins.get(request.loginId);
    if (!login) throw notFound();
    return login;
  }

  async loginCancel(request: { loginId: string }): Promise<EngineLoginView> {
    const login = this.logins.cancel(request.loginId);
    if (!login) throw notFound();
    return login;
  }

  /** Stop every sign-in under way; for shutdown. */
  close(): void {
    this.updateHost.close();
    this.logins.close();
  }
}

/**
 * This machine's engines as the agents run them (the `posix-user`
 * platform): found as main finds them, updated by main's detected update,
 * never installed automatically, and signed in through the person's login
 * shell. `bins` are the configured CLIs (`DISPATCH_CLAUDE_BIN` and so on).
 */
export function localEngineWorkload(
  bins: Partial<Record<AcpEngineId, string>>,
  seams: Pick<EngineLoginDeps, "command" | "env" | "linkTimeoutMs"> & {
    updates?: Partial<Record<AcpEngineId, ManagedCommand>>;
    installs?: Partial<Record<AcpEngineId, ManagedCommand>>;
  } = {}
): EngineWorkload {
  const statuses = () => engineStatuses(bins, seams.env ?? process.env);
  return new EngineWorkload({
    inspectUpdate: async (engine, action, presentation) => {
      const status = (await statuses()).find((row) => row.id === engine);
      if (!status)
        throw new RunnerCallError({
          code: "unsupported",
          message: "Engine unavailable.",
        });
      const installation = await inspectInstallation(status);
      if (presentation) {
        const view = (
          await withEngineUpdates(await withEngineVersions([status]))
        )[0]!;
        const configured = seams.updates?.[status.id];
        if (configured)
          view.update = {
            ...view.update,
            canUpdate: true,
            reason: "",
            command: [configured.executable, ...configured.args].join(" "),
          };
        return { ...installationOnWire(installation), status: view };
      }
      const override =
        action === "install"
          ? seams.installs?.[status.id]
          : seams.updates?.[status.id];
      if (action === "install" && !override)
        return installationOnWire({
          ...installation,
          canUpdate: false,
          reason: `${LABELS[status.id]} is installed manually on this machine; there is no automatic install here.`,
        });
      if (override)
        return installationOnWire({
          ...installation,
          canUpdate: true,
          probePath: installation.probePath ?? bins[status.id] ?? status.id,
          reason: "",
          command: [override.executable, ...override.args].join(" "),
          run: override,
        });
      return installationOnWire(installation);
    },
    pluginBin: async (engine) =>
      (await findEngineBin(bins[engine] ?? engine)) ?? bins[engine] ?? engine,
    async installations(parts) {
      const found = await statuses();
      const versioned =
        parts.version || parts.actions
          ? await withEngineVersions(found)
          : found;
      if (!parts.actions)
        return versioned.map((status) => ({
          id: status.id,
          installed: status.installed,
          version: status.version,
          actions: [],
        }));
      const updates = await withEngineUpdates(versioned);
      return updates.map((status) => ({
        id: status.id,
        installed: status.installed,
        version: status.version,
        // Local install is always manual (see missingEngineMessage).
        actions: status.installed && status.update.canUpdate ? ["update"] : [],
      }));
    },
    logins: {
      resolveBin: async (engine) =>
        (await statuses()).find((status) => status.id === engine)?.path ?? null,
      ...seams,
    },
  });
}

/**
 * Runs engine install/update/sign-in on a runner's non-root workload
 * account. Self-contained: `runner.ts` constructs this from its own
 * `RunnerConfig` and calls `handle()` for the `"engine"` command kind — this
 * module never reads `runner.json` or touches the wire transport itself.
 *
 * Every spawned process goes through the same `setpriv` privilege drop the
 * guest ACP host and repo tool already use, so an engine's CLI always runs
 * as the workload identity, never as this (root) process.
 */

const MANAGED_PACKAGES: Record<RunnerEngine, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  opencode: "opencode-ai",
};

const LABELS: Record<RunnerEngine, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export type ManagedCommand = {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

/**
 * One engine's configuration on this runner: its enforced launch path (the
 * same absolute path the ACP host launches, or null when not installed),
 * and any operator-approved install/update command overrides. Without an
 * update override, the selected installation is detected as on main.
 * An omitted install command leaves installation manual.
 */
export type RunnerEngineConfig = {
  bin: string | null;
  install?: ManagedCommand;
  update?: ManagedCommand;
};

export type EngineRunnerExecutorConfig = {
  uid: number;
  gid: number;
  bundledRuntime?: string;
  /** Merged into every spawned process's environment (HOME, PATH, CA, …). */
  env: NodeJS.ProcessEnv;
  hostCommand?: string[];
  hostCall?: <K extends EngineHostCallName>(
    op: K,
    request: Req<K>
  ) => Promise<Res<K>>;
  engines: Partial<Record<RunnerEngine, RunnerEngineConfig>>;
  /**
   * Test seam: how a command is wrapped to run as the workload identity.
   * Defaults to the same `setpriv` drop the guest ACP host and repo tool
   * use. Never overridden outside tests — production always drops privileges.
   */
  wrap?: (bin: string, args: string[]) => { bin: string; args: string[] };
};

function setprivWrap(
  uid: number,
  gid: number
): (bin: string, args: string[]) => { bin: string; args: string[] } {
  const privArgs = executionArgs(uid, gid);
  return (bin, args) => ({
    bin: setpriv,
    args: [...privArgs, bin, ...args],
  });
}

type RunResult = { code: number | null; spawnError?: string };

/**
 * `--version` output reduced to a safe version token, or null. Never falls
 * back to the raw line: arbitrary CLI stderr/stdout must not reach a
 * persisted inventory or the browser as if it were a version number.
 */
const SAFE_VERSION = /^\d+\.\d+(?:\.\d+)?[\w.+-]{0,40}$/;
function sanitizeVersion(output: string): string | null {
  const line = output.trim().split("\n")[0]?.trim() ?? "";
  const match = /\d+\.\d+(?:\.\d+)?[\w.+-]*/.exec(line)?.[0];
  return match && SAFE_VERSION.test(match) ? match : null;
}

export class EngineRunnerExecutor {
  private installingBundledPackage = false;
  private readonly workload: EngineWorkload;
  private readonly wrap: NonNullable<EngineRunnerExecutorConfig["wrap"]>;

  constructor(private readonly config: EngineRunnerExecutorConfig) {
    this.wrap = config.wrap ?? setprivWrap(config.uid, config.gid);
    this.workload = new EngineWorkload({
      installations: (parts) =>
        Promise.all(
          RUNNER_ENGINES.map((engine) => this.installation(engine, parts))
        ),
      logins: {
        resolveBin: async (engine) => (await this.resolveEngine(engine)).bin,
        // loginScript's own argv already starts with "/bin/sh"; wrap that
        // whole command behind the same privilege drop every runner exec uses.
        command: (bin, args, opts) => {
          const [shBin, ...shArgs] = loginScript(bin, args, opts);
          return this.wrap(shBin!, shArgs);
        },
        env: config.env,
        // A staged login (Codex) writes its scratch CODEX_HOME under the
        // dropped-privilege workload identity, not this (root) process —
        // the default root-owned 0700 mkdtemp would refuse that write, so
        // this chowns it to the workload before the CLI ever touches it.
        createStageDir: async () => {
          const dir = await mkdtemp(
            path.join(os.tmpdir(), "dispatch-engine-login-")
          );
          await chown(dir, config.uid, config.gid);
          return dir;
        },
      },
    });
  }

  private hostWorker?: ChildProcessWithoutNullStreams;
  private hostSequence = 0;
  private readonly hostBins = new Map<RunnerEngine, string>();
  private readonly hostPending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  async callHost<K extends EngineHostCallName>(
    op: K,
    request: Req<K>
  ): Promise<Res<K>> {
    if (op === "engine.list")
      return (await this.workload.list(
        request as Req<"engine.list">
      )) as Res<K>;
    if (op === "engine.login.start")
      return (await this.workload.loginStart(
        request as Req<"engine.login.start">
      )) as Res<K>;
    if (op === "engine.login.submit")
      return (await this.workload.loginSubmit(
        request as { loginId: string; code: string }
      )) as Res<K>;
    if (op === "engine.login.status")
      return (await this.workload.loginStatus(
        request as { loginId: string }
      )) as Res<K>;
    if (op === "engine.login.cancel")
      return (await this.workload.loginCancel(
        request as { loginId: string }
      )) as Res<K>;
    if (this.config.hostCall) return this.config.hostCall(op, request);
    if (!this.hostWorker) {
      const [bin, ...args] = this.config.hostCommand ?? [];
      if (!bin)
        throw new RunnerCallError({
          code: "unavailable",
          message: "Engine workload worker is unavailable.",
        });
      const command = this.wrap(bin, args);
      const child = spawn(command.bin, command.args, {
        cwd: this.config.env.HOME,
        env: this.config.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.hostWorker = child;
      // Keep diagnostics out of the framed stdout channel.
      child.stderr.on("data", () => {});
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const response = JSON.parse(line);
          const pending = this.hostPending.get(response.id);
          if (!pending) return;
          this.hostPending.delete(response.id);
          if (response.error)
            pending.reject(new RunnerCallError(response.error));
          else pending.resolve(response.data);
        } catch {
          child.kill();
        }
      });
      let ended = false;
      const lost = () => {
        if (ended) return;
        ended = true;
        if (this.hostWorker === child) this.hostWorker = undefined;
        for (const pending of this.hostPending.values())
          pending.reject(
            new RunnerCallError({
              code: "unknown_outcome",
              message: "Engine workload continuity was lost.",
            })
          );
        this.hostPending.clear();
        lines.close();
      };
      child.on("error", lost);
      child.on("close", lost);
      child.stdin.on("error", () => {});
    }
    const worker = this.hostWorker;
    const bins: Record<string, string> = {};
    const updates: Partial<Record<RunnerEngine, ManagedCommand>> = {};
    const installs: Partial<Record<RunnerEngine, ManagedCommand>> = {};
    for (const engine of RUNNER_ENGINES) {
      if (
        !this.hostBins.has(engine) ||
        ("engine" in request && request.engine === engine)
      )
        this.hostBins.set(
          engine,
          (await this.resolveBin(engine)) ??
            this.config.engines[engine]?.bin ??
            engine
        );
      bins[engine] = this.hostBins.get(engine)!;
      const cfg = this.config.engines[engine];
      if (cfg?.install && bins[engine] === cfg.bin)
        installs[engine] =
          this.bundledCommand(engine, cfg.install) ?? cfg.install;
      if (cfg?.update && bins[engine] === cfg.bin)
        updates[engine] = this.bundledCommand(engine, cfg.update) ?? cfg.update;
      if (
        op === "engine.update.inspect" &&
        "engine" in request &&
        request.engine === engine
      ) {
        for (const commands of [installs, updates]) {
          const step = commands[engine];
          if (
            step?.env?.BUN_BE_BUN === "1" &&
            step.executable === this.config.bundledRuntime &&
            !(Number((await this.probe("node")).version?.split(".")[0]) >= 22)
          ) {
            const withRuntime = {
              ...step,
              refresh: {
                executable: step.executable,
                args: ["add", "--global", `node-linux-${process.arch}@22`],
                env: step.env,
              },
            };
            commands[engine] = withRuntime;
          }
        }
      }
    }
    if (this.hostWorker !== worker)
      throw new RunnerCallError({
        code: "unknown_outcome",
        message: "Engine workload continuity was lost.",
      });
    const id = ++this.hostSequence;
    const response = new Promise<unknown>((resolve, reject) =>
      this.hostPending.set(id, { resolve, reject })
    );
    worker.stdin.write(
      JSON.stringify({ id, call: { op, request }, bins, updates, installs }) +
        "\n"
    );
    return (await response) as Res<K>;
  }

  private run(
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    onChunk?: (chunk: string) => void
  ): Promise<RunResult> {
    return new Promise((resolve) => {
      const command = this.wrap(executable, args);
      const child = spawn(command.bin, command.args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, timeoutMs);
      const read = (chunk: Buffer) => onChunk?.(chunk.toString("utf8"));
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          code: null,
          spawnError: (error as NodeJS.ErrnoException).code,
        });
      });
    });
  }

  /**
   * Whether `bin` actually runs under the workload identity, and the safe
   * version token it reports. A configured path is a launch-time target,
   * not evidence of installation — a fresh host's `runner.json` names every
   * engine's enforced path before any of them exist, so this always probes
   * the real process rather than trusting path presence.
   */
  private async probe(
    bin: string
  ): Promise<{ installed: boolean; version: string | null }> {
    let output = "";
    const { code, spawnError } = await this.run(
      bin,
      ["--version"],
      this.config.env,
      5_000,
      (chunk) => {
        output = (output + chunk).slice(-2_000);
      }
    );
    if (spawnError || code !== 0) return { installed: false, version: null };
    return { installed: true, version: sanitizeVersion(output) };
  }

  /**
   * Whether a configured install/update command's own executable can run
   * at all. `setpriv` itself is a fixed system path, so a missing target
   * (e.g. no npm on the workload's PATH) is never a Node-level spawn
   * error — setpriv starts fine and the shell it execs into exits 127.
   * Both failure shapes must be checked.
   */
  private async installerFailure(
    command: ManagedCommand
  ): Promise<string | undefined> {
    const { spawnError, code } = await this.run(
      command.executable,
      ["--version"],
      { ...this.config.env, ...command.env },
      5_000
    );
    if (code === 0 && !spawnError) return;
    if (spawnError === "ENOENT" || code === 127)
      return "Installer executable not found";
    if (spawnError === "EACCES" || code === 126)
      return "Runner account cannot execute the installer";
    return code === null
      ? "Installer version check did not finish"
      : `Installer version check exited with code ${code}`;
  }

  private canUseSharedBin(engine: RunnerEngine): boolean {
    const cfg = this.config.engines[engine];
    const home = this.config.env.HOME;
    return Boolean(
      cfg?.install &&
      home &&
      cfg.bin === path.join(home, ".local", "bin", engine)
    );
  }

  // Only installer defaults can fall back. An operator pin is authoritative.
  private async resolveEngine(engine: RunnerEngine) {
    const cfg = this.config.engines[engine];
    const bin = cfg?.bin ?? null;
    const result = bin
      ? await this.probe(bin)
      : { installed: false, version: null };
    if (!result.installed && this.canUseSharedBin(engine)) {
      for (const dir of new Set(this.config.env.PATH?.split(path.delimiter))) {
        if (!path.isAbsolute(dir)) continue;
        const shared = path.join(dir, engine);
        if (shared === bin) continue;
        const probed = await this.probe(shared);
        if (probed.installed) return { bin: shared, ...probed };
      }
    }
    return { bin, ...result };
  }

  async resolveBin(engine: RunnerEngine): Promise<string | null> {
    if (!this.canUseSharedBin(engine))
      return this.config.engines[engine]?.bin ?? null;
    return (await this.resolveEngine(engine)).bin;
  }

  private bundledCommand(
    engine: RunnerEngine,
    step: ManagedCommand
  ): ManagedCommand | null {
    const runtime = this.config.bundledRuntime;
    if (!runtime || !this.canUseSharedBin(engine)) return null;
    const prefix = path.join(this.config.env.HOME!, ".local");
    const pkg = MANAGED_PACKAGES[engine] + "@latest";
    const bundled = {
      executable: runtime,
      args: ["add", "--global", "--trust", pkg],
      env: { BUN_BE_BUN: "1", BUN_INSTALL: prefix },
    };
    // Earlier managed installs wrote npm commands to runner.json. Recognize
    // exactly those defaults so existing pairings can use the bundled runtime.
    const legacy = {
      executable: "npm",
      args: ["install", "--global", "--prefix", prefix, pkg],
    };
    return isDeepStrictEqual(step, legacy) || isDeepStrictEqual(step, bundled)
      ? bundled
      : null;
  }

  private async ensureManagedNode(command: ManagedCommand): Promise<boolean> {
    const usable = async () =>
      Number((await this.probe("node")).version?.split(".")[0]) >= 22;
    if (await usable()) return true;
    const result = await this.run(
      command.executable,
      ["add", "--global", `node-linux-${process.arch}@22`],
      { ...this.config.env, ...command.env },
      90_000
    );
    return result.code === 0 && (await usable());
  }

  /** One engine's installation and the configured install or update it offers. */
  private async installation(
    engine: RunnerEngine,
    parts: EngineListParts
  ): Promise<EngineInstallation> {
    const cfg = this.config.engines[engine];
    // Whether it runs at all is its version probe, so that always runs here.
    const { bin, installed, version } = await this.resolveEngine(engine);
    const actions: EngineSupportedAction[] = [];
    let detail: string | undefined;
    let issue: string | undefined;
    if (!parts.actions) return { id: engine, installed, version, actions };
    if (!installed && cfg?.install) {
      detail = await this.installerFailure(
        this.bundledCommand(engine, cfg.install) ?? cfg.install
      );
      if (detail) issue = "install-unavailable";
      else actions.push("install");
    }
    if (installed) {
      const plan = await this.callHost("engine.update.inspect", { engine });
      if (plan.canUpdate) actions.push("update");
    }
    return {
      id: engine,
      installed,
      version,
      actions,
      ...(detail ? { detail } : {}),
      ...(issue ? { issue } : {}),
    };
  }

  /** The scope-aware engine list and supported actions, for a snapshot view. */
  async inventory(): Promise<EngineInventoryEntry[]> {
    return (await this.workload.list()).entries;
  }

  /** Run one operation; `onEvent` receives any progress before the ack returns. */
  async handle(
    operation: EngineOperation,
    onEvent?: (event: EngineOperationEvent) => void
  ): Promise<EngineOperationAck> {
    if (isEngineCapabilityOperation(operation)) {
      return {
        ok: false,
        unsupported: true,
        error: "Engine capabilities require a workload worker.",
      };
    }
    switch (operation.type) {
      case "contract":
        try {
          return {
            ok: true,
            result: await this.callHost(
              operation.call.op,
              operation.call.request as never
            ),
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof RunnerCallError && {
              failure: { code: error.code, message: error.message },
            }),
          };
        }
      case "status": {
        const entries = await this.inventory();
        onEvent?.({ type: "inventory", entries });
        return { ok: true };
      }
      case "install":
        return this.runManaged(operation.engine, "install", onEvent);
      case "update":
        return this.runManaged(operation.engine, "update", onEvent);
      case "login_start":
        return loginAck(
          this.workload.loginStart({
            engine: operation.engine,
            ...(operation.restart !== undefined && {
              restart: operation.restart,
            }),
          }),
          onEvent
        );
      case "login_submit":
        return loginAck(this.workload.loginSubmit(operation), onEvent);
      case "login_cancel":
        return loginAck(this.workload.loginCancel(operation));
      case "login_status":
        return loginAck(this.workload.loginStatus(operation));
    }
  }

  private async runManaged(
    engine: RunnerEngine,
    kind: "install" | "update",
    onEvent?: (event: EngineOperationEvent) => void
  ): Promise<EngineOperationAck> {
    const cfg = this.config.engines[engine];
    const step = kind === "install" ? cfg?.install : cfg?.update;
    if (
      kind === "update" &&
      (!step || (await this.resolveBin(engine)) !== cfg?.bin)
    )
      return this.executeDetectedUpdate(engine, onEvent);
    if (!step) {
      return {
        ok: false,
        error: `No managed install command is configured for ${LABELS[engine]} on this runner.`,
      };
    }
    const bundled = this.bundledCommand(engine, step);
    if (!bundled)
      return this.executeManaged(engine, kind, step, false, onEvent);
    if (this.installingBundledPackage)
      return {
        ok: false,
        error:
          "Another engine installation is in progress. Try again when it finishes.",
      };
    this.installingBundledPackage = true;
    try {
      return await this.executeManaged(engine, kind, bundled, true, onEvent);
    } finally {
      this.installingBundledPackage = false;
    }
  }

  private async executeDetectedUpdate(
    engine: RunnerEngine,
    onEvent?: (event: EngineOperationEvent) => void
  ): Promise<EngineOperationAck> {
    const plan = await this.callHost("engine.update.inspect", { engine });
    if (!plan.canUpdate || !plan.run) return { ok: false, error: plan.reason };
    const port = engineUpdatePort({
      call: (op, input) => this.callHost(op, input),
    });
    const operationId = randomUUID();
    const bin = plan.probePath ?? plan.realPath!;
    const before = await port.verify(bin);
    const runner = port.runner({
      output: (outputChunk) =>
        onEvent?.({
          type: "operation_progress",
          operationId,
          engine,
          phase: "update",
          message: "",
          outputChunk,
        }),
    });
    const refresh =
      !plan.run.refresh ||
      (
        await runner(plan.run.refresh.executable, plan.run.refresh.args, {
          env: plan.run.refresh.env,
          timeoutMs: 60_000,
        })
      ).exitCode === 0;
    const result = refresh
      ? await runner(plan.run.executable, plan.run.args, {
          env: plan.run.env,
          timeoutMs: 120_000,
        })
      : null;
    const after = await port.verify(bin);
    const success = Boolean(
      before && after && compareVersions(after, before) > 0
    );
    const message = success
      ? `Update completed. Verified installed version ${after}.`
      : result?.exitCode === 0
        ? "Update command completed, but a newer installed version could not be verified. Recheck status before retrying."
        : "Update command failed. Review the output before retrying.";
    onEvent?.({
      type: "operation_complete",
      operationId,
      engine,
      success,
      message,
    });
    return success
      ? { ok: true, operationId, message }
      : { ok: false, error: message };
  }

  private async executeManaged(
    engine: RunnerEngine,
    kind: "install" | "update",
    step: ManagedCommand,
    bundled: boolean,
    onEvent?: (event: EngineOperationEvent) => void
  ): Promise<EngineOperationAck> {
    const cfg = this.config.engines[engine];
    const current = await this.resolveEngine(engine);
    if (current.installed && current.bin !== cfg?.bin) {
      return {
        ok: false,
        error: "This engine is maintained by the runner administrator.",
      };
    }
    const operationId = randomUUID();
    onEvent?.({
      type: "operation_progress",
      operationId,
      engine,
      phase: kind,
      message: kind === "install" ? "Installing…" : "Updating…",
    });
    if (bundled && !(await this.ensureManagedNode(step))) {
      const message =
        "Could not install the engine runtime. Check this runner’s access to the package registry.";
      onEvent?.({
        type: "operation_complete",
        operationId,
        engine,
        success: false,
        message,
      });
      return { ok: false, error: message };
    }
    const before = current.version;
    const result = await this.run(
      step.executable,
      step.args,
      { ...this.config.env, ...step.env },
      180_000,
      (chunk) => {
        onEvent?.({
          type: "operation_progress",
          operationId,
          engine,
          phase: kind,
          message: "",
          outputChunk: chunk.slice(0, 4_000),
        });
      }
    );
    const commandFailed = result.spawnError !== undefined || result.code !== 0;
    const after = cfg?.bin ? (await this.probe(cfg.bin)).version : null;
    const label = kind === "install" ? "Install" : "Update";
    const advanced =
      kind === "install"
        ? Boolean(after)
        : Boolean(before && after && compareVersions(after, before) > 0);
    // An update command can legitimately exit 0 and do nothing — the
    // engine was already current. That's success, not a failed update.
    const upToDate =
      !commandFailed && kind === "update" && !advanced && Boolean(before);
    const success = !commandFailed && (advanced || upToDate);
    const message = commandFailed
      ? `${label} command failed${result.code !== null ? ` (exit code ${result.code})` : ""}.`
      : upToDate
        ? `Already up to date (version ${after}).`
        : advanced
          ? `${label} completed. Verified installed version ${after}.`
          : `${label} command completed, but a ${kind === "install" ? "new" : "newer"} installed version could not be verified.`;
    onEvent?.({
      type: "operation_complete",
      operationId,
      engine,
      success,
      message,
    });
    return success
      ? { ok: true, operationId, message }
      : { ok: false, error: message };
  }

  /** Stop every sign-in under way; for shutdown. */
  close(): void {
    this.hostWorker?.kill();
    this.workload.close();
  }
}

/** A sign-in's wire v1 ack; `onEvent`, when given, hears the login too. */
async function loginAck(
  login: Promise<EngineLoginView>,
  onEvent?: (event: EngineOperationEvent) => void
): Promise<EngineOperationAck> {
  try {
    const view = toLoginView(await login);
    onEvent?.({ type: "login_update", login: view });
    return { ok: true, login: view };
  } catch (error) {
    if (error instanceof RunnerCallError)
      return { ok: false, error: error.message };
    throw error;
  }
}

function toLoginView(login: {
  id: string;
  engine: RunnerEngine;
  status: EngineLoginView["status"];
  url?: string;
  userCode?: string;
  needsCode: boolean;
  detail?: string;
  error?: string;
  expiresAt?: string;
  finishedAt?: string;
}): EngineLoginView {
  return login;
}
