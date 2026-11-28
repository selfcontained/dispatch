import { detectDefaultBranch } from "../shared/git/default-branch.js";
import type { LaunchFolderProbes } from "@dispatch/runner-protocol/in-process";
import { pathFromWire } from "@dispatch/runner-protocol/contract";
import os from "node:os";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { runCommand } from "../shared/lib/run-command.js";
import { resolveTilde } from "../shared/lib/resolve-tilde.js";
export type PathProbePolicy = (path: string, home: string) => boolean;

export async function inspectLocalPath(
  resolved: string,
  shouldSkipAutomaticMacPathProbe: PathProbePolicy
) {
  if (!path.isAbsolute(resolved)) {
    return {
      exists: false,
      isDirectory: false,
      isGitRepo: false,
      privacyRestricted: false,
      resolvedPath: resolved,
    };
  }
  if (shouldSkipAutomaticMacPathProbe(resolved, os.homedir())) {
    return {
      exists: false,
      isDirectory: false,
      isGitRepo: false,
      privacyRestricted: true,
      resolvedPath: resolved,
    };
  }
  try {
    const info = await stat(resolved).catch(() => null);
    const exists = info !== null;
    const isDirectory = exists && info.isDirectory();
    let isGitRepo = false;
    if (isDirectory) {
      const result = await runCommand(
        "git",
        ["-C", resolved, "rev-parse", "--is-inside-work-tree"],
        { timeoutMs: 3_000, allowedExitCodes: [0, 1, 128] }
      );
      isGitRepo = result.exitCode === 0 && result.stdout.trim() === "true";
    }
    return {
      exists,
      isDirectory,
      isGitRepo,
      privacyRestricted: false,
      resolvedPath: resolved,
    };
  } catch {
    return {
      exists: false,
      isDirectory: false,
      isGitRepo: false,
      privacyRestricted: false,
      resolvedPath: resolved,
    };
  }
}

export async function completeLocalPath(
  raw: string,
  shouldSkipAutomaticMacPathProbe: PathProbePolicy,
  limit = 20
) {
  const resolved = resolveTilde(raw);
  if (!path.isAbsolute(resolved)) {
    return { completions: [] };
  }
  try {
    const parentDir = path.dirname(resolved);
    const partial = path.basename(resolved).toLowerCase();
    const isExactDir = raw.endsWith("/");
    const searchDir = isExactDir ? resolved : parentDir;
    const searchPartial = isExactDir ? "" : partial;

    if (shouldSkipAutomaticMacPathProbe(searchDir, os.homedir())) {
      return { completions: [], privacyRestricted: true };
    }

    const entries = await readdir(searchDir, { withFileTypes: true });
    const dirs = entries
      .filter((entry) => {
        if (!entry.isDirectory()) return false;
        if (entry.name.startsWith(".") && !searchPartial.startsWith(".")) {
          return false;
        }
        return entry.name.toLowerCase().startsWith(searchPartial);
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, Math.max(0, Math.min(20, limit)))
      .map((entry) => path.join(searchDir, entry.name));

    const homeDir = os.homedir();
    const completions = dirs.map((dir) =>
      raw.startsWith("~") && dir.startsWith(homeDir)
        ? "~" + dir.slice(homeDir.length)
        : dir
    );

    return { completions, privacyRestricted: false };
  } catch {
    return { completions: [], privacyRestricted: false };
  }
}

export async function listLocalRemoteBranches(input: string) {
  const cwd = resolveTilde(input);
  const result = await runCommand(
    "git",
    ["-C", cwd, "ls-remote", "--heads", "origin"],
    { timeoutMs: 15_000 }
  );
  const defaultBranch = await detectDefaultBranch(cwd);
  const branches = result.stdout
    .split("\n")
    .map((line) => line.replace(/^.*refs\/heads\//, "").trim())
    .filter(Boolean)
    .sort((a, b) => {
      if (a === defaultBranch) return -1;
      if (b === defaultBranch) return 1;
      return a.localeCompare(b);
    });
  return { branches };
}

export function createLaunchFolderProbes(
  privacy: PathProbePolicy
): LaunchFolderProbes {
  return {
    async inspect(path) {
      const facts = await inspectLocalPath(resolveTilde(path), privacy);
      return {
        ...facts,
        resolvedPath: pathFromWire(facts.resolvedPath),
        canonicalPath: null,
        projectRoot: null,
        git: null,
      };
    },
    complete: ({ prefix, limit }) => completeLocalPath(prefix, privacy, limit),
    remoteHeads: ({ path }) => listLocalRemoteBranches(path),
  };
}
