import os from "node:os";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { localDefaultBranch } from "../shared/git/default-branch.js";
import { runCommand } from "../shared/lib/run-command.js";
import { resolveTilde } from "../shared/lib/resolve-tilde.js";
import { shouldSkipAutomaticMacPathProbe } from "../shared/mac-path-privacy.js";

export async function inspectLocalPath(resolved: string) {
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

export async function completeLocalPath(raw: string) {
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
      .slice(0, 20)
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
  const branches = result.stdout
    .split("\n")
    .map((line) => line.replace(/^.*refs\/heads\//, "").trim())
    .filter(Boolean)
    .sort((a, b) => {
      if (a === "main") return -1;
      if (b === "main") return 1;
      if (a === "master") return -1;
      if (b === "master") return 1;
      return a.localeCompare(b);
    });
  return { branches, defaultBranch: await localDefaultBranch(cwd) };
}
