import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { runCommand } from "./lib/run-command.js";

export const WORKTREE_MODES = ["ask", "auto", "off"] as const;
export type WorktreeMode = (typeof WORKTREE_MODES)[number];

export type RepoDispatchConfig = {
  worktreeMode: WorktreeMode;
};

export type ResolvedRepoConfig = {
  repoRoot: string;
  configPath: string;
  config: RepoDispatchConfig;
  source: "default" | "file";
};

export class RepoConfigError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "RepoConfigError";
    this.statusCode = statusCode;
  }
}

const DEFAULT_REPO_CONFIG: RepoDispatchConfig = {
  worktreeMode: "ask"
};

export function isWorktreeMode(value: unknown): value is WorktreeMode {
  return typeof value === "string" && (WORKTREE_MODES as readonly string[]).includes(value);
}

function coerceObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export async function resolveRepoConfig(cwd: string): Promise<ResolvedRepoConfig> {
  const repoRoot = await resolveRepoRoot(cwd);
  const configPath = path.join(repoRoot, ".dispatch", "config.json");

  const parsed = await readJsonFile(configPath);
  if (!parsed) {
    return { repoRoot, configPath, config: DEFAULT_REPO_CONFIG, source: "default" };
  }

  const parsedObject = coerceObject(parsed);
  const mode = parsedObject?.worktreeMode;
  if (!isWorktreeMode(mode)) {
    return { repoRoot, configPath, config: DEFAULT_REPO_CONFIG, source: "default" };
  }

  return {
    repoRoot,
    configPath,
    config: {
      worktreeMode: mode
    },
    source: "file"
  };
}

export async function writeWorktreeMode(cwd: string, worktreeMode: WorktreeMode): Promise<ResolvedRepoConfig> {
  const repoRoot = await resolveRepoRoot(cwd);
  const configDir = path.join(repoRoot, ".dispatch");
  const configPath = path.join(configDir, "config.json");

  const existing = coerceObject(await readJsonFile(configPath)) ?? {};
  existing.worktreeMode = worktreeMode;

  await mkdir(configDir, { recursive: true });

  const tempPath = path.join(configDir, `config.json.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tempPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  await rename(tempPath, configPath);

  return {
    repoRoot,
    configPath,
    config: {
      worktreeMode
    },
    source: "file"
  };
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
    if (!stdout) {
      throw new Error("empty repo root");
    }
    return path.resolve(stdout);
  } catch {
    throw new RepoConfigError("No git repository found for the provided working directory.", 404);
  }
}
