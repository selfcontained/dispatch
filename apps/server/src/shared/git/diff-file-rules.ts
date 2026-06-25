import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const EXCLUDED_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Podfile.lock",
  "Package.resolved",
  "composer.lock",
  "mix.lock",
]);

const UNTRACKED_MAX_BYTES = 1_024 * 1_024;
const BINARY_PROBE_BYTES = 8_192;

export function shouldExcludePath(filePath: string): boolean {
  return EXCLUDED_BASENAMES.has(path.basename(filePath));
}

export function looksBinary(buffer: Buffer): boolean {
  const probeLength = Math.min(buffer.length, BINARY_PROBE_BYTES);
  for (let i = 0; i < probeLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const parts = content.split("\n");
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

export async function readUntrackedFile(
  worktreePath: string,
  filePath: string
): Promise<{ lines: number; content: string | null }> {
  const fullPath = path.resolve(worktreePath, filePath);
  const realWorktree = path.resolve(worktreePath);
  if (
    !fullPath.startsWith(realWorktree + path.sep) &&
    fullPath !== realWorktree
  ) {
    return { lines: 0, content: null };
  }
  try {
    const info = await lstat(fullPath);
    if (!info.isFile()) return { lines: 0, content: null };
    if (info.size === 0) return { lines: 0, content: null };
    if (info.size > UNTRACKED_MAX_BYTES) return { lines: 0, content: null };
    const buffer = await readFile(fullPath);
    if (looksBinary(buffer)) return { lines: 0, content: null };
    const text = buffer.toString("utf8");
    return { lines: countLines(text), content: text };
  } catch {
    return { lines: 0, content: null };
  }
}
