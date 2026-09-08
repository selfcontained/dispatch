import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessPath } from "@dispatch/shared";

import { shouldSkipAutomaticMacPathProbe } from "../../shared/mac-path-privacy.js";

/**
 * Completions for the Harness composer's "@" path picker: the entries of
 * the directory the typed prefix names, filtered by its last segment. The
 * reply keeps the spelling the user typed (relative, "~/…", or absolute)
 * so the picked path reads the same way in the prompt.
 */

const MAX_QUERY_LENGTH = 1024;
const MAX_ENTRIES = 50;

/** Whether a directory is the agent's working tree or something inside it. */
function isInsideTree(dir: string, cwd: string): boolean {
  const rel = path.relative(cwd, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Where a typed prefix points: the directory to list, and the segment to match. */
export function resolvePathQuery(
  query: string,
  input: { cwd: string; home?: string }
): { dir: string; typedDir: string; segment: string } | null {
  if (query.length > MAX_QUERY_LENGTH || query.includes("\0")) return null;
  const idx = query.lastIndexOf("/");
  const typedDir = idx >= 0 ? query.slice(0, idx + 1) : "";
  const segment = idx >= 0 ? query.slice(idx + 1) : query;
  const home = input.home ?? os.homedir();
  let dir: string;
  if (typedDir === "") dir = input.cwd;
  else if (typedDir.startsWith("/")) dir = typedDir;
  else if (typedDir === "~/" || typedDir.startsWith("~/"))
    dir = path.join(home, typedDir.slice(2));
  else dir = path.join(input.cwd, typedDir);
  return { dir, typedDir, segment };
}

/**
 * Entries matching the typed prefix: directories first, then files, by
 * name. Each kind is capped on its own, so a directory whose files sort
 * ahead of its subdirectories still lists those subdirectories.
 */
export async function listHarnessPaths(
  query: string,
  input: { cwd: string; home?: string; platform?: NodeJS.Platform }
): Promise<HarnessPath[]> {
  const resolved = resolvePathQuery(query, input);
  if (!resolved) return [];
  const { dir, typedDir, segment } = resolved;
  // "~" alone completes to the home directory before anything is listed.
  if (typedDir === "" && segment === "~") return [{ path: "~", kind: "dir" }];
  // On macOS a service that reads ~/Desktop, ~/Documents, ~/Downloads or
  // iCloud Drive raises a TCC prompt no daemon can answer, so the read hangs
  // or is denied silently. /api/v1/system/path-completions refuses these
  // before readdir and so does this.
  const home = input.home ?? os.homedir();
  if (shouldSkipAutomaticMacPathProbe(dir, home, input.platform)) return [];
  // Outside the agent's working tree only directories list, which is the
  // posture of the completion route this parallels. Inside it, naming files
  // is the whole point of the picker.
  const dirsOnly = !isInsideTree(dir, input.cwd);
  const showHidden = segment.startsWith(".");
  const needle = segment.toLowerCase();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const matched = entries
    .filter((entry) => {
      if (!showHidden && entry.name.startsWith(".")) return false;
      return entry.name.toLowerCase().startsWith(needle);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const dirs: HarnessPath[] = [];
  const files: HarnessPath[] = [];
  for (const entry of matched) {
    if (dirs.length >= MAX_ENTRIES && files.length >= MAX_ENTRIES) break;
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDir = (await stat(path.join(dir, entry.name))).isDirectory();
      } catch {
        continue;
      }
    }
    if (!isDir && dirsOnly) continue;
    const bucket = isDir ? dirs : files;
    if (bucket.length >= MAX_ENTRIES) continue;
    bucket.push({
      path: typedDir + entry.name,
      kind: isDir ? "dir" : "file",
    });
  }
  return [...dirs, ...files].slice(0, MAX_ENTRIES);
}
