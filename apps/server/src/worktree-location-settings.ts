import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

import type { Pool } from "pg";

import { getSetting } from "./db/settings.js";
import { worktreePathSlug } from "./shared/git/worktree.js";

export const WORKTREE_LOCATION_KEY = "worktree_location";
export const WORKTREE_DIRECTORY_KEY = "worktree_directory";

export const VALID_WORKTREE_LOCATIONS = [
  "sibling",
  "nested",
  "directory",
] as const;

export type WorktreeLocation = (typeof VALID_WORKTREE_LOCATIONS)[number];

export type WorktreePlacement = {
  worktreeLocation: WorktreeLocation;
  /** Set only for "directory": the absolute folder new worktrees go in. */
  worktreeDirectory?: string;
};

export function isWorktreeLocation(value: unknown): value is WorktreeLocation {
  return (
    typeof value === "string" &&
    (VALID_WORKTREE_LOCATIONS as readonly string[]).includes(value)
  );
}

/**
 * The instance-wide worktree placement setting, falling back to "sibling" when
 * unset or invalid. This is the only reader: the MCP launch handler, the agent
 * creation route, and the assisted-update route all resolve placement through
 * here, so an MCP-launched agent lands in the same place a UI-launched one
 * would.
 *
 * "directory" without a stored directory reads as "sibling": the setting
 * route never stores that pair, so it only arises from a hand-edited row.
 */
export async function getWorktreePlacement(
  pool: Pool
): Promise<WorktreePlacement> {
  const raw = await getSetting(pool, WORKTREE_LOCATION_KEY);
  const location = isWorktreeLocation(raw) ? raw : "sibling";
  if (location !== "directory") return { worktreeLocation: location };
  const directory = (await getSetting(pool, WORKTREE_DIRECTORY_KEY))?.trim();
  if (!directory) return { worktreeLocation: "sibling" };
  return { worktreeLocation: "directory", worktreeDirectory: directory };
}

export class WorktreeDirectoryError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "WorktreeDirectoryError";
  }
}

/**
 * Check a worktree directory is usable right now: absolute, already existing,
 * a directory, writable. It is never created here — when the folder sits on a
 * removable drive, a missing folder means the drive is absent, and creating
 * it would quietly put worktrees back on the internal disk.
 */
export async function assertWorktreeDirectoryUsable(
  directory: string
): Promise<string> {
  const trimmed = directory.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new WorktreeDirectoryError(
      "The worktree directory must be an absolute path."
    );
  }
  const resolved = path.resolve(trimmed);
  const unavailable = (why: string): WorktreeDirectoryError =>
    new WorktreeDirectoryError(
      `The worktree directory ${resolved} is unavailable (${why}). Connect the drive it lives on, or change Settings → Worktrees.`
    );
  const info = await stat(resolved).catch((err: NodeJS.ErrnoException) => {
    throw unavailable(
      err.code === "ENOENT" ? "it does not exist" : (err.code ?? "unreadable")
    );
  });
  if (!info.isDirectory()) throw unavailable("it is not a directory");
  await access(resolved, constants.W_OK).catch(() => {
    throw unavailable("it is not writable");
  });
  return resolved;
}

/**
 * Where a new worktree goes for a placement, or undefined for "sibling"
 * (createGitWorktree's own default). Placement is local-only by construction:
 * it is resolved here, at the local launch, and nothing else reads it.
 * "directory" never falls back: an unusable folder throws
 * WorktreeDirectoryError.
 */
export async function resolveWorktreePathOverride(
  placement: WorktreePlacement,
  target: {
    originalCwd: string;
    worktreeBranchName: string;
    createNewBranch: boolean;
  }
): Promise<string | undefined> {
  const slug = worktreePathSlug(target.worktreeBranchName, {
    createNewBranch: target.createNewBranch,
  });
  if (placement.worktreeLocation === "nested") {
    return path.join(target.originalCwd, ".dispatch", "worktrees", slug);
  }
  if (placement.worktreeLocation === "directory") {
    const directory = await assertWorktreeDirectoryUsable(
      placement.worktreeDirectory ?? ""
    );
    return path.join(directory, `${path.basename(target.originalCwd)}-${slug}`);
  }
  return undefined;
}
