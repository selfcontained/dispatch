import type { Req, Res } from "@dispatch/runner-protocol/contract";
import type { EngineHostCallName } from "@dispatch/runner-protocol/engine-management";
type EngineCalls = {
  call<K extends EngineHostCallName>(op: K, input: Req<K>): Promise<Res<K>>;
};
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { access, constants, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  compareVersions,
  clearEngineVersionCache,
  engineStatuses,
  engineVersion,
  withEngineVersions,
  type EngineStatus,
} from "./engine-availability.js";
import type { AcpEngineId } from "@dispatch/runner-protocol/host";
import type {
  CommandRunner,
  RunCommandResult,
} from "../shared/lib/run-command.js";
import { childProcessEnv } from "../shared/process/child-environment.js";

const packages = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  opencode: "@opencode/cli",
};
const brewNames = {
  claude: "claude-code",
  codex: "codex",
  opencode: "opencode",
};
type Command = {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  refresh?: { executable: string; args: string[]; env?: NodeJS.ProcessEnv };
};
export type Installation = {
  realPath: string | null;
  probePath?: string;
  source: "native" | "npm" | "homebrew-formula" | "homebrew-cask" | "unknown";
  /** Verified package identity for the selected binary, never a proposed replacement. */
  packageChannel?: string;
  migrationWarning?: string;
  canUpdate: boolean;
  reason: string;
  command: string;
  latestKey: string;
  target: string;
  run?: Command;
};
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
type InstallMetadata = {
  name?: unknown;
  bin?: string | Record<string, unknown>;
  source?: { path?: unknown; tap?: unknown; version?: unknown };
  loaded_from_api?: boolean;
  loaded_from_internal_api?: boolean;
  uninstall_artifacts?: Array<{ binary?: unknown }>;
};
async function json(file: string): Promise<InstallMetadata | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}
async function owned(
  files: string[],
  writable: boolean,
  allowGroupWrite = false
): Promise<boolean> {
  if (!process.getuid || process.getuid() === 0) return false;
  try {
    for (const file of files) {
      const info = await stat(file);
      if (
        info.uid !== process.getuid() ||
        (info.mode & (allowGroupWrite ? 0o002 : 0o022)) !== 0
      )
        return false;
      if (writable) await access(file, constants.W_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/** Inspect the launch-selected file; never search for a different installation. */
export async function inspectInstallation(
  status: EngineStatus,
  home = os.homedir()
): Promise<Installation> {
  const result: Installation = {
    realPath: null,
    probePath: status.path ?? undefined,
    source: "unknown",
    canUpdate: false,
    reason:
      "Installation source could not be verified. Update it manually with its installer.",
    command: status.install,
    latestKey:
      status.id === "opencode" && status.path
        ? "unknown:"
        : `npm:${packages[status.id]}`,
    target: status.path ?? status.id,
  };
  if (!status.path) {
    result.reason = "Install this CLI, then sign in to use it.";
    return result;
  }
  try {
    result.realPath = await realpath(status.path);
  } catch {
    return result;
  }
  const real = result.realPath;
  result.target = real;
  const ambiguous =
    /(?:^|\/)(?:\.nvm|\.fnm|\.asdf|\.volta|mise|shims|node_versions)(?:\/|$)/.test(
      `${status.path}/${real}`
    );
  const deny =
    "Manual update required: installation ownership, permissions, or package manager could not be verified.";
  const enable = async (
    directories: string[],
    run: Command,
    identities: string[] = [],
    allowGroupWrite = false
  ) => {
    result.reason = deny;
    if (
      !ambiguous &&
      (await owned(
        [...directories, path.dirname(status.path!)],
        true,
        allowGroupWrite
      )) &&
      (await owned([real, ...identities], false, allowGroupWrite))
    ) {
      result.canUpdate = true;
      result.reason = "Verified user-owned installation.";
      result.run = run;
    }
  };
  // Native Claude has a versioned binary behind ~/.local/bin/claude.
  const nativeRoot = path.join(home, ".local/share/claude/versions");
  if (
    status.id === "claude" &&
    path.dirname(real) === nativeRoot &&
    status.path === path.join(home, ".local/bin/claude")
  ) {
    result.source = "native";
    result.target = nativeRoot;
    result.command = `${quote(status.path)} update`;
    await enable([nativeRoot], { executable: status.path, args: ["update"] });
    return result;
  }
  // Homebrew's real path identifies the exact formula/cask; misleading prefix names do not.
  const brew = /^(.*)\/(Cellar|Caskroom)\/([^/]+)\/([^/]+)\//.exec(real);
  if (
    brew &&
    (brew[3] === brewNames[status.id] ||
      (status.id === "opencode" &&
        brew[2] === "Cellar" &&
        brew[3] === "opencode-v2"))
  ) {
    const [, prefix, kind, name, version] = brew;
    const root = path.join(prefix!, kind!, name!, version!);
    const cask = kind === "Caskroom";
    result.target = path.dirname(root);
    result.source = cask ? "homebrew-cask" : "homebrew-formula";
    result.latestKey = `${cask ? "cask" : "formula"}:${name}`;
    result.command = `${quote(path.join(prefix!, "bin/brew"))} upgrade --${cask ? "cask" : "formula"} ${name}`;
    result.reason = deny;
    const receiptPath = cask
      ? path.join(prefix!, kind!, name!, ".metadata/INSTALL_RECEIPT.json")
      : path.join(root, "INSTALL_RECEIPT.json");
    const receipt = await json(receiptPath);
    const source = receipt?.source;
    const tap =
      typeof source?.tap === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(source.tap)
        ? source.tap
        : null;
    const namedSource =
      typeof source?.path === "string" &&
      new RegExp(`/${name}\\.(?:rb|json)$`).test(source.path);
    const apiLoaded =
      receipt?.loaded_from_api === true ||
      receipt?.loaded_from_internal_api === true;
    const artifactBins = Array.isArray(receipt?.uninstall_artifacts)
      ? receipt.uninstall_artifacts.flatMap((artifact) =>
          artifact &&
          typeof artifact === "object" &&
          Array.isArray(artifact.binary)
            ? artifact.binary.filter(
                (bin): bin is string => typeof bin === "string"
              )
            : []
        )
      : [];
    const artifactMatches = (
      await Promise.all(
        artifactBins.map(async (bin) => {
          try {
            return (await realpath(path.resolve(root, bin))) === real;
          } catch {
            return false;
          }
        })
      )
    ).includes(true);
    const [tapOwner, tapRepo] = tap?.split("/") ?? [];
    const tapSource =
      typeof source?.path === "string" &&
      tapOwner &&
      tapRepo &&
      source.path.startsWith(
        path.join(prefix!, "Library/Taps", tapOwner, `homebrew-${tapRepo}`) +
          "/"
      ) &&
      namedSource;
    const identity = cask
      ? tap === "homebrew/cask" &&
        source?.version === version &&
        (namedSource || (apiLoaded && artifactMatches))
      : tap !== null &&
        (tap === "homebrew/core" ? namedSource || apiLoaded : tapSource);
    if (identity) {
      result.packageChannel =
        tap === "homebrew/core" || tap === "homebrew/cask"
          ? name!
          : `${tap}/${name}`;
      if (
        status.id === "opencode" &&
        tap === "anomalyco/tap" &&
        name === "opencode"
      ) {
        result.migrationWarning =
          "The selected opencode formula is the V1 channel. It conflicts with anomalyco/tap/opencode-v2 because both install opencode. Updating this installation does not switch to V2; back up V1 configuration and data before a manual migration.";
      }
      const executable = path.join(prefix!, "bin/brew");
      const qualified =
        tap === "homebrew/core" || tap === "homebrew/cask"
          ? name!
          : `${tap}/${name}`;
      result.command = `${quote(executable)} upgrade --${cask ? "cask" : "formula"} ${qualified}`;
      if (tap !== "homebrew/core" && tap !== "homebrew/cask")
        result.latestKey = `brew:${JSON.stringify({ executable, name: qualified })}`;
      if (status.path !== path.join(prefix!, "bin", status.id)) {
        result.reason =
          "The selected path is pinned to a version. Configure the moving Homebrew bin path before updating.";
        return result;
      }
      await access(executable, constants.X_OK)
        .then(async () => {
          await enable(
            [root, path.dirname(root), prefix!],
            {
              executable,
              args: ["upgrade", cask ? "--cask" : "--formula", qualified],
              refresh: {
                executable,
                args: ["update"],
                env: {
                  HOMEBREW_NO_AUTO_UPDATE: undefined,
                  NONINTERACTIVE: "1",
                },
              },
              env: {
                HOMEBREW_NO_AUTO_UPDATE: "1",
                HOMEBREW_NO_INSTALL_CLEANUP: "1",
                NONINTERACTIVE: "1",
              },
            },
            [executable, receiptPath],
            true
          );
        })
        .catch(() => {});
    } else result.latestKey = "unknown:";
    return result;
  }
  // Verify package.json and bin mapping, not just a path containing node_modules.
  let dir = path.dirname(real);
  while (dir !== path.dirname(dir)) {
    const pkg = await json(path.join(dir, "package.json"));
    if (
      pkg?.name === packages[status.id] ||
      (status.id === "opencode" && pkg?.name === "opencode-ai")
    ) {
      const packageName = pkg.name as string;
      const bins =
        typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
      const matches = await Promise.all(
        bins
          .filter((bin): bin is string => typeof bin === "string")
          .map(async (bin) => {
            try {
              return (await realpath(path.resolve(dir, bin))) === real;
            } catch {
              return false;
            }
          })
      );
      if (!matches.includes(true)) return result;
      result.source = "npm";
      result.packageChannel = packageName;
      result.latestKey = `npm:${packageName}`;
      if (status.id === "opencode" && packageName === "opencode-ai") {
        result.migrationWarning =
          "The selected opencode-ai package is the V1 channel. Updating it does not switch to @opencode/cli. Back up V1 configuration and data before a manual migration; both packages install opencode.";
      }
      result.target = dir;
      const suffix = path.join("lib", "node_modules", packageName);
      const prefix = dir.endsWith(`/${suffix}`)
        ? dir.slice(0, -(suffix.length + 1))
        : null;
      result.reason = deny;
      if (!prefix) return result;
      const npm = path.join(prefix, "bin/npm");
      result.command = `${quote(npm)} install --global --prefix ${quote(prefix)} ${packageName}@latest`;
      if (
        !prefix.startsWith(`${home}/`) ||
        status.path !== path.join(prefix, "bin", path.basename(status.path))
      )
        return result;
      try {
        const npmReal = await realpath(npm);
        const expected = path.join(
          prefix,
          "lib/node_modules/npm/bin/npm-cli.js"
        );
        const npmPkg = await json(
          path.join(prefix, "lib/node_modules/npm/package.json")
        );
        const node = path.join(prefix, "bin/node");
        if (npmReal !== expected || npmPkg?.name !== "npm") return result;
        await access(node, constants.X_OK);
        await enable(
          [
            dir,
            path.dirname(dir),
            path.join(prefix, "lib/node_modules"),
            prefix,
            path.join(prefix, "bin"),
          ],
          {
            executable: node,
            args: [
              npmReal,
              "install",
              "--global",
              "--prefix",
              prefix,
              `${packageName}@latest`,
            ],
            env: {
              PATH: `${path.join(prefix, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
            },
          },
          [npmReal, node]
        );
      } catch {
        /* Manual instructions remain available. */
      }
      return result;
    }
    dir = path.dirname(dir);
  }
  return result;
}

/** Fire-and-forget metadata checks: GET never waits on the registry. */
export class LatestVersions {
  private cache = new Map<
    string,
    { expires: number; version: string | null; pending: boolean }
  >();
  constructor(
    private fetcher: (
      url: string,
      init: { signal: AbortSignal }
    ) => Promise<Response> = fetch,
    private now: () => number = Date.now,
    private runner: CommandRunner = (command, args, options) =>
      runUpdate(command, args, options)
  ) {}
  get(key: string): { latestVersion: string | null; latestPending: boolean } {
    if (key.startsWith("unknown:"))
      return { latestVersion: null, latestPending: false };
    let entry = this.cache.get(key);
    if (!entry || entry.expires <= this.now()) {
      entry = {
        expires: this.now() + 3 * 60 * 60_000,
        version: null,
        pending: true,
      };
      this.cache.set(key, entry);
      const current = entry;
      const [kind, ...rest] = key.split(":");
      const name = rest.join(":");
      const lookup =
        kind === "brew"
          ? (async () => {
              const info = JSON.parse(name) as {
                executable: string;
                name: string;
              };
              const response = await this.runner(
                info.executable,
                ["info", "--json=v2", "--formula", info.name],
                {
                  timeoutMs: 8_000,
                  env: { HOMEBREW_NO_AUTO_UPDATE: "1", NONINTERACTIVE: "1" },
                }
              );
              if (response.exitCode !== 0)
                throw new Error("Metadata unavailable");
              const data = JSON.parse(response.stdout) as {
                formulae?: Array<{
                  full_name?: string;
                  versions?: { stable?: string };
                }>;
              };
              return data.formulae?.find(
                (formula) => formula.full_name === info.name
              )?.versions?.stable;
            })()
          : (async () => {
              const url =
                kind === "npm"
                  ? `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`
                  : `https://formulae.brew.sh/api/${kind}/${name}.json`;
              const response = await this.fetcher(url, {
                signal: AbortSignal.timeout(8_000),
              });
              if (!response.ok) throw new Error("Metadata unavailable");
              const data = (await response.json()) as {
                version?: unknown;
                versions?: { stable?: unknown };
              };
              return kind === "formula" ? data.versions?.stable : data.version;
            })();
      void lookup
        .then((value) => {
          current.version =
            typeof value === "string" &&
            /^\d+\.\d+(?:\.\d+)?[\w.+,-]*$/.test(value)
              ? value
              : null;
        })
        .catch(() => {
          current.version = null;
        })
        .finally(() => {
          current.pending = false;
        });
    }
    return { latestVersion: entry.version, latestPending: entry.pending };
  }
}
const latest = new LatestVersions((input, init) => fetch(input, init));
export async function withEngineUpdates(statuses: EngineStatus[]) {
  return Promise.all(
    statuses.map(async (status) => {
      const {
        run: _run,
        target: _target,
        latestKey,
        ...installation
      } = await inspectInstallation(status);
      const metadata = status.installed
        ? latest.get(latestKey)
        : { latestVersion: null, latestPending: false };
      return {
        ...status,
        update: {
          ...installation,
          ...metadata,
          available: Boolean(
            status.version &&
            metadata.latestVersion &&
            compareVersions(metadata.latestVersion, status.version) > 0
          ),
        },
      };
    })
  );
}

/** Dedicated bounded runner: output capture is capped while the process runs. */
export type UpdateObserver = {
  output?: (chunk: string) => void;
  spawned?: (pid: number) => Promise<void>;
  /** Host ports use this to settle a gate after its held process exits. */
  closed?: () => void;
};
export const observedUpdateRunner =
  (observer: UpdateObserver = {}): CommandRunner =>
  (command, args, options) =>
    new Promise((resolve, reject) => {
      // A closed stdin before the durable PID write must never run the updater.
      // Positional arguments preserve the verified executable and arguments;
      // none of them are evaluated as shell source.
      if (process.platform === "win32") {
        reject(
          new Error(
            "Automatic updates require a POSIX process gate. Update manually on Windows."
          )
        );
        return;
      }
      const child = spawn(
        "/bin/sh",
        [
          "-c",
          'IFS= read -r dispatch_start || exit 1; [ "$dispatch_start" = start ] || exit 1; exec "$@" </dev/null',
          "dispatch-engine-update",
          command,
          ...args,
        ],
        {
          env: { ...childProcessEnv(), ...options?.env },
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        }
      );
      let stdout = "",
        stderr = "";
      let timedOut = false;
      const cap = (old: string, chunk: Buffer) =>
        (old + String(chunk)).slice(-32_000);
      child.stdout.on("data", (chunk) => {
        stdout = cap(stdout, chunk);
        observer.output?.(String(chunk));
      });
      child.stderr.on("data", (chunk) => {
        stderr = cap(stderr, chunk);
        observer.output?.(String(chunk));
      });
      const recorded =
        child.pid && observer.spawned
          ? observer.spawned(child.pid)
          : Promise.resolve();
      // Release only after the PID snapshot commits. If this server dies before
      // then, the gate receives EOF and exits without executing any command.
      child.stdin.on("error", () => {});
      void recorded.then(
        () => child.stdin.end("start\n"),
        () => child.stdin.destroy()
      );
      // A persistence failure must never allow an untracked command to continue.
      void recorded.catch(() => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      });
      const timeoutMs = options?.timeoutMs ?? 120_000;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
        stderr = cap(
          stderr,
          Buffer.from(`\nCommand timed out after ${timeoutMs / 1000} seconds.`)
        );
      }, timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        observer.closed?.();
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        observer.closed?.();
        void recorded.then(
          () =>
            resolve({ exitCode: timedOut ? 1 : (code ?? 1), stdout, stderr }),
          reject
        );
      });
    });
export const runUpdate = observedUpdateRunner();
const active = new Set<string>();
export async function updateEngine(
  id: AcpEngineId,
  overrides: Partial<Record<AcpEngineId, string>>,
  runner = runUpdate
) {
  const status = (await engineStatuses(overrides)).find(
    (item) => item.id === id
  )!;
  const installation = await inspectInstallation(status);
  if (!installation.canUpdate || !installation.run)
    throw new Error(installation.reason);
  if (active.has(installation.target))
    throw new Error("An update for this installation is already running.");
  active.add(installation.target);
  try {
    let success = false,
      output: string;
    const logs: string[] = [];
    try {
      const execute = async (command: Command, timeoutMs: number) => {
        const result = await runner(command.executable, command.args, {
          env: command.env,
          timeoutMs,
        });
        logs.push(result.stdout, result.stderr);
        return result.exitCode === 0;
      };
      const refreshed =
        !installation.run.refresh ||
        (await execute(installation.run.refresh, 60_000));
      success = refreshed && (await execute(installation.run, 120_000));
      output = logs.join("\n").trim().slice(-64_000);
    } catch (error) {
      output = [...logs, String(error)].join("\n").trim().slice(-64_000);
    }
    // npm launchers may stay unchanged while their package files change.
    clearEngineVersionCache();
    const fresh = await withEngineUpdates(
      await withEngineVersions(await engineStatuses(overrides))
    );
    return { success, output, engine: fresh.find((item) => item.id === id) };
  } finally {
    active.delete(installation.target);
  }
}

function mayExist(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
type ProcessState = Extract<
  Res<"engine.operation">,
  { type: "operation_state" }
>;
type Entry = {
  state: ProcessState;
  release: () => void;
  abort: () => void;
  started: Promise<Res<"engine.update.spawn">>;
  done: Promise<void>;
  finishedAt?: number;
};
const notFound = () =>
  new RunnerCallError({
    code: "not_found",
    message: "Engine operation not found.",
  });

export function installationOnWire(
  installation: Installation
): Res<"engine.update.inspect"> {
  const command = (value: NonNullable<Installation["run"]>) => ({
    executable: value.executable,
    args: value.args,
    ...(value.env && {
      env: Object.fromEntries(
        Object.entries(value.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      ),
    }),
  });
  return {
    ...installation,
    run: installation.run && {
      ...command(installation.run),
      ...(installation.run.refresh && {
        refresh: command(installation.run.refresh),
      }),
    },
  };
}

/** One port instance, used identically in the child and the in-process fallback. */
export class EngineUpdateHost {
  private readonly operations = new Map<string, Entry>();
  // These compact ids outlive the heavy result so a late duplicate never spawns.
  private readonly tombstones = new Map<
    string,
    "running" | "completed" | "failed" | "never_released"
  >();
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly maxRequestIds: number;
  private readonly log: (message: string) => void;
  private ceilingLogged = false;

  constructor(
    private readonly runner = observedUpdateRunner,
    options: {
      retentionMs?: number;
      now?: () => number;
      maxRequestIds?: number;
      log?: (message: string) => void;
    } = {}
  ) {
    this.retentionMs = options.retentionMs ?? 10 * 60_000;
    this.now = options.now ?? (() => performance.now());
    this.maxRequestIds = options.maxRequestIds ?? 100_000;
    this.log = options.log ?? console.error;
  }

  private expire(): void {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    let next = Infinity;
    const now = this.now();
    for (const [id, entry] of this.operations) {
      if (entry.finishedAt === undefined) continue;
      const remaining = entry.finishedAt + this.retentionMs - now;
      if (remaining <= 0) this.operations.delete(id);
      else next = Math.min(next, remaining);
    }
    if (Number.isFinite(next)) {
      this.expiryTimer = setTimeout(() => this.expire(), next);
      this.expiryTimer.unref?.();
    }
  }

  private expired(): never {
    throw new RunnerCallError({
      code: "unknown_outcome",
      message: "Engine operation result is no longer retained.",
    });
  }

  async spawn(
    request: Req<"engine.update.spawn">
  ): Promise<Res<"engine.update.spawn">> {
    this.expire();
    const prior = this.operations.get(request.requestId);
    if (prior) return prior.started;
    if (this.tombstones.has(request.requestId)) this.expired();
    if (this.tombstones.size >= this.maxRequestIds) {
      if (!this.ceilingLogged) {
        this.log(
          `Engine update host reached its ${this.maxRequestIds} request-id safety ceiling; new commands will not start. Existing ids remain protected.`
        );
        this.ceilingLogged = true;
      }
      throw new RunnerCallError({
        code: "busy",
        message: "Engine update host request-id safety ceiling reached.",
      });
    }
    this.tombstones.set(request.requestId, "running");
    let released = false;
    let aborted = false;
    let release!: () => void;
    let abort!: () => void;
    const gate = new Promise<void>((resolve, reject) => {
      release = () => {
        if (aborted) return;
        released = true;
        resolve();
      };
      abort = () => {
        if (released) return;
        aborted = true;
        reject(
          new Error(
            "Engine operation gate was never released; command did not run."
          )
        );
      };
    });
    void gate.catch(() => {});
    let started!: (value: Res<"engine.update.spawn">) => void;
    let failed!: (error: unknown) => void;
    const start = new Promise<Res<"engine.update.spawn">>((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const state: ProcessState = {
      type: "operation_state",
      operationId: request.requestId,
      running: true,
      output: "",
      outputOffset: 0,
    };
    const entry: Entry = { state, release, abort, started: start, done };
    this.operations.set(request.requestId, entry);
    const complete = (kind: "completed" | "failed" | "never_released") => {
      state.running = false;
      entry.finishedAt = this.now();
      this.tombstones.set(request.requestId, kind);
      finished();
      this.expire();
    };
    const run: CommandRunner = this.runner({
      spawned: async (pid) => {
        state.pid = pid;
        started({ operationId: request.requestId, pid });
        await gate;
      },
      closed: () => {
        if (!released) abort();
      },
      output: (chunk) => {
        state.output = (state.output + chunk).slice(-64_000);
        state.outputOffset += chunk.length;
      },
    });
    void run(request.command.executable, request.command.args, {
      env: request.command.env,
      timeoutMs: request.timeoutMs,
    }).then(
      (result: RunCommandResult) => {
        state.result = {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
        complete("completed");
      },
      (error: unknown) => {
        state.error = String(error);
        failed(error);
        complete(released ? "failed" : "never_released");
      }
    );
    return start;
  }

  async release(
    request: Req<"engine.update.release">
  ): Promise<Res<"engine.update.release">> {
    this.expire();
    const entry = this.operations.get(request.operationId);
    if (!entry) {
      if (this.tombstones.has(request.operationId)) this.expired();
      throw notFound();
    }
    if (request.abort) entry.abort();
    else entry.release();
    await entry.done;
    return {};
  }

  async operation(
    request: Req<"engine.operation">
  ): Promise<Res<"engine.operation">> {
    this.expire();
    const entry = this.operations.get(request.operationId);
    if (!entry) {
      if (this.tombstones.has(request.operationId)) this.expired();
      throw notFound();
    }
    return structuredClone(entry.state);
  }

  close(): void {
    // A gate that never received its durable acknowledgement must not run.
    for (const entry of this.operations.values()) entry.abort();
  }

  async probe(
    request: Req<"engine.update.probe">
  ): Promise<Res<"engine.update.probe">> {
    const alive = request.pids.map((pid) =>
      mayExist(
        request.groups && process.platform !== "win32" ? -Math.abs(pid) : pid
      )
    );
    clearEngineVersionCache();
    return {
      alive,
      version: request.bin ? await engineVersion(request.bin) : null,
    };
  }
}

export function engineUpdatePort(engines: EngineCalls) {
  return {
    clearEngineVersionCache,
    prepare: async (
      engine: "claude" | "codex" | "opencode",
      _overrides: Partial<Record<AcpEngineId, string>>,
      action: "install" | "update" = "update"
    ): Promise<Installation> =>
      engines.call("engine.update.inspect", { engine, action }),
    verify: async (bin: string) =>
      (await engines.call("engine.update.probe", { pids: [], bin })).version,
    processExists: async (pid: number) => {
      try {
        return (
          (
            await engines.call("engine.update.probe", {
              pids: [Math.abs(pid)],
              groups: true,
            })
          ).alive[0] ?? true
        );
      } catch (error) {
        if (
          error instanceof RunnerCallError &&
          ["unavailable", "unknown_outcome", "not_found"].includes(error.code)
        )
          return true;
        throw error;
      }
    },
    runner:
      (observer: UpdateObserver): CommandRunner =>
      async (executable, args, options) => {
        const env =
          options?.env &&
          Object.fromEntries(
            Object.entries(options.env).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string"
            )
          );
        const operation = await engines.call("engine.update.spawn", {
          requestId: randomUUID(),
          command: { executable, args, ...(env && { env }) },
          timeoutMs: options?.timeoutMs ?? 120_000,
        });
        try {
          // The host is still blocked on stdin until this durable PID write commits.
          await observer.spawned?.(operation.pid);
        } catch (error) {
          await engines
            .call("engine.update.release", {
              operationId: operation.operationId,
              abort: true,
            })
            .catch(() => {});
          throw error;
        }
        let releaseError: unknown;
        const released = engines
          .call("engine.update.release", { operationId: operation.operationId })
          .catch((error: unknown) => {
            releaseError = error;
          });
        let offset = 0;
        while (true) {
          if (releaseError) throw releaseError;
          const state = await engines.call("engine.operation", {
            operationId: operation.operationId,
          });
          if (state.type !== "operation_state")
            throw new Error("Invalid engine process state.");
          if (state.outputOffset > offset)
            observer.output?.(
              state.output.slice(
                -Math.min(state.outputOffset - offset, state.output.length)
              )
            );
          offset = state.outputOffset;
          if (state.error) throw new Error(state.error);
          if (state.result) {
            await released;
            if (releaseError) throw releaseError;
            return state.result;
          }
          if (!state.running)
            throw new RunnerCallError({
              code: "unknown_outcome",
              message: "Engine process outcome is unavailable.",
            });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
  };
}
