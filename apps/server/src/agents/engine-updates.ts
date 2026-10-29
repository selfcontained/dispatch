import { access, constants, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  compareVersions,
  clearEngineVersionCache,
  engineStatuses,
  withEngineVersions,
  type EngineStatus,
} from "./engine-availability.js";
import type { AcpEngineId } from "./acp/engine-spec.js";
import type { CommandRunner } from "../shared/lib/run-command.js";

const packages = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  opencode: "opencode-ai",
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
  source: "native" | "npm" | "homebrew-formula" | "homebrew-cask" | "unknown";
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
    source: "unknown",
    canUpdate: false,
    reason:
      "Installation source could not be verified. Update it manually with its installer.",
    command: status.install,
    latestKey: `npm:${packages[status.id]}`,
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
  if (brew && brew[3] === brewNames[status.id]) {
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
    if (pkg?.name === packages[status.id]) {
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
      result.target = dir;
      const suffix = path.join("lib", "node_modules", packages[status.id]);
      const prefix = dir.endsWith(`/${suffix}`)
        ? dir.slice(0, -(suffix.length + 1))
        : null;
      result.reason = deny;
      if (!prefix) return result;
      const npm = path.join(prefix, "bin/npm");
      result.command = `${quote(npm)} install --global --prefix ${quote(prefix)} ${packages[status.id]}@latest`;
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
              `${packages[status.id]}@latest`,
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
          env: { ...process.env, ...options?.env },
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
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
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

export type EngineUpdateOperation = {
  id: string;
  engineId: AcpEngineId;
  status: "running" | "succeeded" | "failed" | "interrupted";
  phase: "starting" | "refreshing" | "updating" | "complete";
  message: string;
  output: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  retryBlocked: boolean;
};
type StoredOperation = EngineUpdateOperation & {
  owner: string;
  ownerPid: number;
  childPid: number | null;
  spawnGated: boolean;
  target: string;
};
type OperationRecords = Partial<Record<AcpEngineId, StoredOperation>>;
export interface EngineOperationStore {
  exclusive<T>(work: (records: OperationRecords) => Promise<T>): Promise<T>;
}
const OPERATION_KEY = "engine_update_operations";
/** One transaction lock covers all engines, including shared brew/npm prefixes. */
export function engineOperationStore(pool: Pool): EngineOperationStore {
  return {
    async exclusive(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(1852271177, 1)");
        const result = await client.query<{ value: string }>(
          "SELECT value FROM settings WHERE key = $1",
          [OPERATION_KEY]
        );
        const records: OperationRecords = result.rows[0]
          ? JSON.parse(result.rows[0].value)
          : {};
        const value = await work(records);
        await client.query(
          `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
          [OPERATION_KEY, JSON.stringify(records)]
        );
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
function mayExist(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function publicOperation(record: StoredOperation): EngineUpdateOperation {
  const {
    owner: _owner,
    ownerPid: _ownerPid,
    childPid: _pid,
    spawnGated: _gate,
    target: _target,
    ...operation
  } = record;
  return operation;
}
/** Server-owned lifecycle. No request/socket owns the command or its exclusion. */
export class EngineUpdateOperations {
  private readonly owner = randomUUID();
  private readonly pendingTerminal = new Map<AcpEngineId, StoredOperation>();
  constructor(
    private readonly store: EngineOperationStore,
    private readonly options: {
      prepare?: (
        id: AcpEngineId,
        overrides: Partial<Record<AcpEngineId, string>>
      ) => Promise<Installation>;
      runner?: (observer: UpdateObserver) => CommandRunner;
      mayExist?: (pid: number) => boolean;
      onError?: (error: unknown) => void;
    } = {}
  ) {}
  private recover(records: OperationRecords) {
    for (const record of Object.values(records)) {
      if (record.status === "running" && record.owner !== this.owner) {
        record.status = "interrupted";
        record.finishedAt = record.updatedAt = new Date().toISOString();
        record.message =
          "Server continuity was lost. The update outcome is unknown; verify the installed version before retrying.";
      }
      if (record.status === "interrupted") {
        const exists = this.options.mayExist ?? mayExist;
        // Existence is only a reason to BLOCK. Never assume a recovered PID is
        // ours or signal it. Same-PID hot reloads cannot use owner PID liveness.
        // The gate plus the interrupted/ID write fence prevents a superseded
        // executor from releasing a new command, including another engine.
        record.retryBlocked =
          (record.ownerPid !== process.pid && exists(record.ownerPid)) ||
          (!record.childPid
            ? !record.spawnGated
            : exists(
                process.platform === "win32"
                  ? record.childPid
                  : -record.childPid
              ));
      }
    }
  }
  private reconcileTerminal(records: OperationRecords) {
    for (const [id, terminal] of this.pendingTerminal) {
      const current = records[id];
      if (
        current?.id === terminal.id &&
        current.owner === this.owner &&
        current.status === "running"
      )
        records[id] = { ...terminal };
    }
  }
  async read(): Promise<Partial<Record<AcpEngineId, EngineUpdateOperation>>> {
    const pending = [...this.pendingTerminal];
    const result = await this.store.exclusive(async (records) => {
      this.reconcileTerminal(records);
      this.recover(records);
      return Object.fromEntries(
        Object.entries(records).map(([id, record]) => [
          id,
          publicOperation(record),
        ])
      );
    });
    // Only discard after the transaction commits; an interrupted/replaced
    // operation is fenced and must never be overwritten by an older result.
    for (const [id, terminal] of pending) {
      if (
        this.pendingTerminal.get(id)?.id === terminal.id &&
        (result[id]?.id !== terminal.id || result[id]?.status !== "running")
      )
        this.pendingTerminal.delete(id);
    }
    return result;
  }
  async start(
    id: AcpEngineId,
    overrides: Partial<Record<AcpEngineId, string>>
  ) {
    const installation = await (this.options.prepare
      ? this.options.prepare(id, overrides)
      : engineStatuses(overrides).then((statuses) =>
          inspectInstallation(statuses.find((status) => status.id === id)!)
        ));
    if (!installation.canUpdate || !installation.run)
      throw new Error(installation.reason);
    const operation = await this.store.exclusive(async (records) => {
      this.reconcileTerminal(records);
      this.recover(records);
      if (
        Object.values(records).some(
          (record) => record.status === "running" || record.retryBlocked
        )
      )
        throw new Error(
          "An engine update is running or its prior outcome is uncertain. Review the previous operation before retrying."
        );
      const now = new Date().toISOString();
      const record: StoredOperation = {
        id: randomUUID(),
        engineId: id,
        status: "running",
        phase: "starting",
        message: "Starting verified installation update.",
        output: "",
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        retryBlocked: true,
        owner: this.owner,
        ownerPid: process.pid,
        childPid: null,
        spawnGated: true,
        target: installation.target,
      };
      records[id] = record;
      return { ...record };
    });
    // Start only after the durable claim commits; disconnection cannot cancel it.
    void this.execute(operation, installation.run).catch((error) =>
      this.options.onError?.(error)
    );
    return publicOperation(operation);
  }
  private async execute(record: StoredOperation, command: Command) {
    let output = "";
    const save = async () => {
      record.output = output;
      record.updatedAt = new Date().toISOString();
      await this.store.exclusive(async (records) => {
        if (
          records[record.engineId]?.id !== record.id ||
          records[record.engineId]?.status === "interrupted"
        )
          throw new Error("Engine operation ownership changed.");
        records[record.engineId] = { ...record };
      });
    };
    // Throttle writes; the in-memory and persisted buffers are both bounded.
    let dirty = false;
    let writes = Promise.resolve();
    const queueSave = () => {
      writes = writes.then(save);
      return writes;
    };
    const timer = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      void queueSave().catch((error) => this.options.onError?.(error));
    }, 250);
    timer.unref();
    const runner = (this.options.runner ?? observedUpdateRunner)({
      output: (chunk) => {
        output = (output + chunk).slice(-64_000);
        dirty = true;
      },
      spawned: async (pid) => {
        record.childPid = pid;
        await queueSave();
      },
    });
    try {
      const execute = async (
        step: Command,
        phase: "refreshing" | "updating",
        timeoutMs: number
      ) => {
        record.phase = phase;
        record.message =
          phase === "refreshing"
            ? "Refreshing package metadata…"
            : "Updating the selected installation…";
        // Persist intent before each spawn. A restart in this gap is uncertain.
        record.childPid = null;
        await queueSave();
        const result = await runner(step.executable, step.args, {
          env: step.env,
          timeoutMs,
        });
        // Injectable runners need not stream their output.
        const finalOutput = [result.stdout, result.stderr]
          .filter(Boolean)
          .join("\n");
        if (finalOutput && !output.endsWith(finalOutput))
          output = (output + "\n" + finalOutput).slice(-64_000);
        return result.exitCode === 0;
      };
      const refreshed =
        !command.refresh ||
        (await execute(command.refresh, "refreshing", 60_000));
      const success =
        refreshed && (await execute(command, "updating", 120_000));
      record.status = success ? "succeeded" : "failed";
      record.message = success
        ? "Update completed."
        : "Update command failed. Review the output before retrying.";
    } catch (error) {
      record.status = "failed";
      record.message = "Update failed. Review the output before retrying.";
      output = (output + "\n" + String(error)).slice(-64_000);
    } finally {
      clearInterval(timer);
      clearEngineVersionCache();
      record.phase = "complete";
      record.finishedAt = new Date().toISOString();
      record.retryBlocked = false;
      // Drain in-flight snapshots before writing the terminal result.
      await writes.catch(() => {});
      record.output = output;
      this.pendingTerminal.set(record.engineId, { ...record });
      await save();
      if (this.pendingTerminal.get(record.engineId)?.id === record.id)
        this.pendingTerminal.delete(record.engineId);
    }
  }
}
