import { access, constants, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
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
export const runUpdate: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...options?.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "",
      stderr = "";
    const cap = (old: string, chunk: Buffer) =>
      (old + String(chunk)).slice(-32_000);
    child.stdout.on("data", (chunk) => {
      stdout = cap(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = cap(stderr, chunk);
    });
    const timeoutMs = options?.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
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
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
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
