import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chown, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RunnerEngine } from "@dispatch/runner-protocol";
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

import { compareVersions } from "../engine-availability.js";
import { EngineLogins, isLoginEngine, loginScript } from "../engine-login.js";

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
 * and the operator-approved commands that install or update whatever lives
 * at that path. Omitting `install`/`update` disables that action — there is
 * no ambiguous ownership detection here, only configured, scoped commands.
 */
export type RunnerEngineConfig = {
  bin: string | null;
  install?: ManagedCommand;
  update?: ManagedCommand;
};

export type EngineRunnerExecutorConfig = {
  uid: number;
  gid: number;
  /** Merged into every spawned process's environment (HOME, PATH, CA, …). */
  env: NodeJS.ProcessEnv;
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
  const privArgs = [
    `--reuid=${uid}`,
    `--regid=${gid}`,
    "--clear-groups",
    "--no-new-privs",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--bounding-set=-all",
    "--",
  ];
  return (bin, args) => ({
    bin: "/usr/bin/setpriv",
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
  private readonly logins: EngineLogins;
  private readonly wrap: NonNullable<EngineRunnerExecutorConfig["wrap"]>;

  constructor(private readonly config: EngineRunnerExecutorConfig) {
    this.wrap = config.wrap ?? setprivWrap(config.uid, config.gid);
    this.logins = new EngineLogins({
      resolveBin: async (engine) => config.engines[engine]?.bin ?? null,
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
    });
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
  private async commandUsable(command: ManagedCommand): Promise<boolean> {
    const { spawnError, code } = await this.run(
      command.executable,
      ["--version"],
      { ...this.config.env, ...command.env },
      5_000
    );
    return spawnError === undefined && code === 0;
  }

  /** The scope-aware engine list and supported actions, for a snapshot view. */
  async inventory(): Promise<EngineInventoryEntry[]> {
    return Promise.all(
      RUNNER_ENGINES.map(async (engine) => {
        const cfg = this.config.engines[engine];
        const bin = cfg?.bin ?? null;
        const probed = bin
          ? await this.probe(bin)
          : { installed: false, version: null };
        const { installed, version } = probed;
        let signedIn: boolean | null = null;
        let detail: string | undefined;
        if (installed && isLoginEngine(engine)) {
          const status = await this.logins.status(engine);
          signedIn = status.signedIn;
          detail = status.detail;
        }
        const actions: EngineSupportedAction[] = [];
        let issue: string | undefined;
        if (!installed && cfg?.install) {
          if (await this.commandUsable(cfg.install)) actions.push("install");
          else issue = "install-unavailable";
        }
        if (installed && cfg?.update) actions.push("update");
        if (installed && isLoginEngine(engine))
          actions.push("login", "login_cancel");
        return {
          id: engine,
          label: LABELS[engine],
          installed,
          signedIn,
          version,
          ...(detail ? { detail } : {}),
          ...(issue ? { issue } : {}),
          actions,
        };
      })
    );
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
      case "status": {
        const entries = await this.inventory();
        onEvent?.({ type: "inventory", entries });
        return { ok: true };
      }
      case "install":
        return this.runManaged(operation.engine, "install", onEvent);
      case "update":
        return this.runManaged(operation.engine, "update", onEvent);
      case "login_start": {
        if (!isLoginEngine(operation.engine)) {
          return {
            ok: false,
            error: `${LABELS[operation.engine]} has no sign-in flow.`,
          };
        }
        const login = await this.logins.start(operation.engine, {
          restart: operation.restart,
        });
        const view = toLoginView(login);
        onEvent?.({ type: "login_update", login: view });
        return { ok: true, login: view };
      }
      case "login_submit": {
        const login = this.logins.submitCode(operation.loginId, operation.code);
        if (!login) return { ok: false, error: "Sign-in not found." };
        const view = toLoginView(login);
        onEvent?.({ type: "login_update", login: view });
        return { ok: true, login: view };
      }
      case "login_cancel": {
        const login = this.logins.cancel(operation.loginId);
        if (!login) return { ok: false, error: "Sign-in not found." };
        return { ok: true, login: toLoginView(login) };
      }
      case "login_status": {
        const login = this.logins.get(operation.loginId);
        if (!login) return { ok: false, error: "Sign-in not found." };
        return { ok: true, login: toLoginView(login) };
      }
    }
  }

  private async runManaged(
    engine: RunnerEngine,
    kind: "install" | "update",
    onEvent?: (event: EngineOperationEvent) => void
  ): Promise<EngineOperationAck> {
    const cfg = this.config.engines[engine];
    const step = kind === "install" ? cfg?.install : cfg?.update;
    if (!step) {
      return {
        ok: false,
        error: `No managed ${kind} command is configured for ${LABELS[engine]} on this runner.`,
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
    const before = cfg?.bin ? (await this.probe(cfg.bin)).version : null;
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
    this.logins.close();
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
