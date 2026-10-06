import { spawn } from "node:child_process";
import { openWorkspaceDirectory } from "./workspace-directory.js";
import path from "node:path";

export type WorkspaceFileIndex = {
  paths: string[];
  truncated: boolean;
  source: "git" | "folders";
};
const MAX_PATHS = 20_000;
const MAX_BYTES = 2_097_152;
const MAX_TIME_MS = 2_000;
const FALLBACK_EXCLUDES = new Set([
  ".git",
  "node_modules",
  ".dispatch",
  ".next",
  ".cache",
  "dist",
  "coverage",
]);

// Names only. Never read file contents or launch a command per keystroke.
function gitIndex(root: string): Promise<WorkspaceFileIndex | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, stdio: ["ignore", "pipe", "ignore"] }
    );
    const names = new Set<string>();
    let bytes = 0;
    let pending = Buffer.alloc(0);
    let settled = false;
    const finish = (truncated: boolean, fallback = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // This is our own read-only child. Killing on limits prevents output or
      // filesystem work from continuing after a partial result is returned.
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve(
        fallback ? null : { paths: [...names].sort(), truncated, source: "git" }
      );
    };
    const timer = setTimeout(() => finish(true), MAX_TIME_MS);
    child.on("error", () => finish(false, true));
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        finish(true);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      let boundary: number;
      while ((boundary = pending.indexOf(0)) !== -1) {
        const name = pending.subarray(0, boundary).toString("utf8");
        pending = pending.subarray(boundary + 1);
        if (
          !name ||
          name.startsWith("/") ||
          name
            .split("/")
            .some((part) => part === ".." || part.toLowerCase() === ".git")
        )
          continue;
        if (names.size >= MAX_PATHS) {
          finish(true);
          return;
        }
        names.add(name);
      }
    });
    child.on("close", (code) => finish(false, code !== 0));
  });
}

async function folderIndex(root: string): Promise<WorkspaceFileIndex> {
  const paths: string[] = [];
  const queue = [""];
  const deadline = Date.now() + MAX_TIME_MS;
  let bytes = 0;
  let visited = 0;
  let truncated = false;
  for (let index = 0; index < queue.length; index++) {
    if (Date.now() > deadline || visited >= MAX_PATHS) {
      truncated = true;
      break;
    }
    const relative = queue[index]!;
    const absolute = path.join(root, relative);
    try {
      const { directory, verify } = await openWorkspaceDirectory(
        root,
        absolute
      );
      const directoryPaths: string[] = [];
      const directoryChildren: string[] = [];
      for await (const entry of directory) {
        if (
          ++visited > MAX_PATHS ||
          Date.now() > deadline ||
          bytes >= MAX_BYTES
        ) {
          truncated = true;
          break;
        }
        if (
          entry.isSymbolicLink() ||
          FALLBACK_EXCLUDES.has(entry.name.toLowerCase())
        )
          continue;
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        bytes += Buffer.byteLength(name);
        if (entry.isDirectory()) directoryChildren.push(name);
        else if (entry.isFile()) directoryPaths.push(name);
      }
      await verify();
      paths.push(...directoryPaths);
      queue.push(...directoryChildren);
    } catch {
      truncated = true;
    }
    if (visited > MAX_PATHS || bytes >= MAX_BYTES) break;
  }
  return { paths: paths.sort(), truncated, source: "folders" };
}

export async function buildWorkspaceFileIndex(
  root: string
): Promise<WorkspaceFileIndex> {
  return (await gitIndex(root)) ?? (await folderIndex(root));
}

/** Four short-lived snapshots per server. Concurrent requests for one root
 * share an in-flight scan; explicit refresh generations rebuild a settled one. */
export function createWorkspaceFileIndexer() {
  const cache = new Map<
    string,
    {
      generation: string;
      expires: number;
      pending: boolean;
      value: Promise<WorkspaceFileIndex>;
    }
  >();
  return (root: string, generation: string): Promise<WorkspaceFileIndex> => {
    const existing = cache.get(root);
    if (
      existing &&
      (existing.pending ||
        (existing.generation === generation && existing.expires > Date.now()))
    )
      return existing.value;
    if (!existing && cache.size >= 4) {
      const evict = [...cache].find(([, entry]) => !entry.pending);
      if (evict) cache.delete(evict[0]);
      else
        return Promise.reject(
          new Error("Filename search is busy. Try again shortly.")
        );
    }
    const entry = {
      generation,
      expires: Date.now() + 30_000,
      pending: true,
      value: Promise.resolve({
        paths: [],
        truncated: false,
        source: "folders",
      } as WorkspaceFileIndex),
    };
    entry.value = buildWorkspaceFileIndex(root).finally(() => {
      entry.pending = false;
    });
    cache.set(root, entry);
    return entry.value;
  };
}
