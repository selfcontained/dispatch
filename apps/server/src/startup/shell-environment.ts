import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

type CaptureFailureReason =
  | "missing_shell"
  | "spawn_failed"
  | "timeout"
  | "output_limit"
  | "nonzero_exit"
  | "invalid_output";

export type LegacyMacEnvironmentStatus =
  | { state: "disabled" }
  | {
      state: "resolved";
      shell: string;
    };

type CaptureOptions = {
  inheritedEnv: NodeJS.ProcessEnv;
  timeoutMs?: number;
  outputLimitBytes?: number;
  terminationGraceMs?: number;
  macShellPath?: string;
  environmentEmitter?: string;
};

type RestorationOptions = {
  platform?: NodeJS.Platform;
  serviceDefinitionPath?: string;
  runtimePath?: string;
  inheritedEnv?: NodeJS.ProcessEnv;
  targetEnv?: NodeJS.ProcessEnv;
  macShellPath?: string;
  environmentEmitter?: string;
};

type CaptureResult =
  | {
      ok: true;
      environment: Record<string, string>;
      shell: string;
    }
  | {
      ok: false;
      shell: string | null;
      reason: CaptureFailureReason;
    };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 500;

async function inspectSupportedShell(
  candidate: string | null | undefined
): Promise<string | null> {
  if (!candidate || !path.isAbsolute(candidate)) return null;

  try {
    await access(candidate, fsConstants.X_OK);
    const canonicalPath = await realpath(candidate);
    const basename = path.basename(canonicalPath);
    if (basename !== "zsh") return null;
    return candidate;
  } catch {
    return null;
  }
}

function buildCaptureScript(
  beginMarker: string,
  endMarker: string,
  nonce: string,
  environmentEmitter?: string
): string {
  const nameVariable = `__dispatch_env_name_${nonce}`;
  const typeVariable = `__dispatch_env_type_${nonce}`;
  const nativeZshEmitter = [
    `function {`,
    `local ${nameVariable} ${typeVariable}`,
    `for ${nameVariable} ${typeVariable} in \${(kv)parameters}; do`,
    `if [[ $${typeVariable} == *-export* ]]; then`,
    `builtin printf '%s=%s\\0' "$${nameVariable}" "\${(P)${nameVariable}}"`,
    `fi`,
    `done`,
    `}`,
  ].join("; ");
  const emit = [
    `builtin printf '%s\\0' '${beginMarker}'`,
    environmentEmitter ?? nativeZshEmitter,
    `builtin printf '%s\\0' '${endMarker}'`,
  ].join("; ");

  return [
    `[[ -f ~/.zprofile ]] && source ~/.zprofile`,
    `[[ -f ~/.zshrc ]] && source ~/.zshrc`,
    emit,
  ].join("; ");
}

export function parseCapturedEnvironment(
  output: Buffer,
  beginMarker: string,
  endMarker: string
): Record<string, string> | null {
  const records = output.toString("utf8").split("\0");
  const beginIndex = records.indexOf(beginMarker);
  const endIndex = records.indexOf(endMarker);
  if (
    beginIndex < 0 ||
    endIndex <= beginIndex ||
    records.lastIndexOf(beginMarker) !== beginIndex ||
    records.lastIndexOf(endMarker) !== endIndex
  ) {
    return null;
  }

  const environment: Record<string, string> = {};
  for (const record of records.slice(beginIndex + 1, endIndex)) {
    if (!record) continue;
    const separator = record.indexOf("=");
    if (separator <= 0) return null;
    const key = record.slice(0, separator);
    environment[key] = record.slice(separator + 1);
  }
  return environment;
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The process group may already have exited.
  }
}

async function captureProcess(
  shellPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: Required<
    Pick<
      CaptureOptions,
      "timeoutMs" | "outputLimitBytes" | "terminationGraceMs"
    >
  >
): Promise<
  { ok: true; stdout: Buffer } | { ok: false; reason: CaptureFailureReason }
> {
  return await new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(shellPath, args, {
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ ok: false, reason: "spawn_failed" });
      return;
    }

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let abortReason: CaptureFailureReason | null = null;
    let escalationTimer: NodeJS.Timeout | null = null;

    const timeout = setTimeout(() => abort("timeout"), options.timeoutMs);

    const finish = (
      result:
        | { ok: true; stdout: Buffer }
        | { ok: false; reason: CaptureFailureReason }
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (escalationTimer) clearTimeout(escalationTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };

    function abort(reason: CaptureFailureReason) {
      if (settled || abortReason) return;
      abortReason = reason;
      signalProcessGroup(child.pid, "SIGTERM");
      escalationTimer = setTimeout(() => {
        signalProcessGroup(child.pid, "SIGKILL");
        finish({ ok: false, reason });
      }, options.terminationGraceMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.outputLimitBytes) {
        abort("output_limit");
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > options.outputLimitBytes) abort("output_limit");
    });
    child.on("error", () => {
      if (!abortReason) finish({ ok: false, reason: "spawn_failed" });
    });
    child.on("close", (code) => {
      if (abortReason) return;
      if (code !== 0) {
        finish({ ok: false, reason: "nonzero_exit" });
        return;
      }
      finish({ ok: true, stdout: Buffer.concat(stdout) });
    });
  });
}

export async function captureLegacyMacEnvironment(
  options: CaptureOptions
): Promise<CaptureResult> {
  const shellPath = await inspectSupportedShell(
    options.macShellPath ?? "/bin/zsh"
  );
  if (!shellPath) {
    return {
      ok: false,
      shell: null,
      reason: "missing_shell",
    };
  }

  const nonce = randomBytes(18).toString("hex");
  const beginMarker = `__DISPATCH_ENV_BEGIN_${nonce}__`;
  const endMarker = `__DISPATCH_ENV_END_${nonce}__`;
  const script = buildCaptureScript(
    beginMarker,
    endMarker,
    nonce,
    options.environmentEmitter
  );
  const args = ["-c", script];
  const result = await captureProcess(shellPath, args, options.inheritedEnv, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputLimitBytes: options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
    terminationGraceMs:
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
  });
  if (!result.ok) {
    return {
      ok: false,
      shell: shellPath,
      reason: result.reason,
    };
  }

  const environment = parseCapturedEnvironment(
    result.stdout,
    beginMarker,
    endMarker
  );
  if (!environment) {
    return {
      ok: false,
      shell: shellPath,
      reason: "invalid_output",
    };
  }

  return {
    ok: true,
    shell: shellPath,
    environment,
  };
}

export function replaceProcessEnvironment(
  captured: Record<string, string>,
  target: NodeJS.ProcessEnv = process.env
): void {
  for (const key of Object.keys(target)) {
    if (!(key in captured)) delete target[key];
  }
  for (const [key, value] of Object.entries(captured)) target[key] = value;
}

export function applyCapturedEnvironment(
  captured: Record<string, string>,
  target: NodeJS.ProcessEnv = process.env
): void {
  replaceProcessEnvironment(captured, target);
  target.TERM ||= "xterm-256color";
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function firstLaunchdProgramArgument(contents: string): string | null {
  const args = contents.match(
    /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/
  );
  const first = args?.[1]?.match(/<string>\s*([\s\S]*?)\s*<\/string>/);
  return first?.[1] === undefined ? null : decodeXmlText(first[1]);
}

export async function shouldRestoreLegacyMacEnvironment(
  options: RestorationOptions = {}
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "darwin") return false;

  const definition =
    options.serviceDefinitionPath ??
    path.join(
      os.homedir(),
      "Library",
      "LaunchAgents",
      "com.dispatch.server.plist"
    );
  try {
    const configuredRuntime = firstLaunchdProgramArgument(
      await readFile(definition, "utf8")
    );
    if (!configuredRuntime || !path.isAbsolute(configuredRuntime)) return false;
    const [configured, current] = await Promise.all([
      realpath(configuredRuntime),
      realpath(options.runtimePath ?? process.execPath),
    ]);
    return configured === current;
  } catch {
    return false;
  }
}

export async function restoreLegacyMacLaunchAgentEnvironment(
  options: RestorationOptions = {}
): Promise<LegacyMacEnvironmentStatus> {
  if (!(await shouldRestoreLegacyMacEnvironment(options))) {
    return { state: "disabled" };
  }

  const result = await captureLegacyMacEnvironment({
    inheritedEnv: { ...(options.inheritedEnv ?? process.env) },
    macShellPath: options.macShellPath,
    environmentEmitter: options.environmentEmitter,
  });
  if (!result.ok) {
    throw new Error(
      `Legacy shell environment restoration failed: ${result.reason}`
    );
  }
  applyCapturedEnvironment(
    result.environment,
    options.targetEnv ?? process.env
  );
  return {
    state: "resolved",
    shell: result.shell,
  };
}
