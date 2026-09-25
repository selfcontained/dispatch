import { realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Pool, PoolClient } from "pg";

import { resolveConfiguredPath } from "../shared/lib/resolve-tilde.js";

const execFileAsync = promisify(execFile);

/** Allocated disk bytes, including unregistered files; never follows nested symlinks. */
export async function sampleArtifactStorage(
  roots: string[],
  signal?: AbortSignal
): Promise<number> {
  signal?.throwIfAborted();
  const canonical = new Set<string>();
  for (const root of roots) {
    signal?.throwIfAborted();
    try {
      canonical.add(await realpath(resolveConfiguredPath(root)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  // Avoid counting custom directories twice when they live under another root.
  const unique = [...canonical].filter(
    (root) =>
      ![...canonical].some(
        (parent) => parent !== root && root.startsWith(parent + path.sep)
      )
  );
  signal?.throwIfAborted();
  if (!unique.length) return 0;
  const result = await execFileAsync("du", ["-sk", ...unique], {
    timeout: 30_000,
    signal,
    killSignal: "SIGKILL",
  });
  const sizes = result.stdout
    .trim()
    .split("\n")
    .map((line) => Number(line.match(/^\s*(\d+)\s/)?.[1]));
  if (
    sizes.length !== unique.length ||
    sizes.some((size) => !Number.isFinite(size))
  ) {
    throw new Error("Invalid disk usage response");
  }
  return sizes.reduce((sum, size) => sum + size * 1024, 0);
}

/** Bounded discovery, retiring a checked-out client on timeout or opt-out. */
export function discoverArtifactRoots(
  pool: Pool,
  signal: AbortSignal
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let client: PoolClient | null = null;
    let settled = false;
    let terminalError: Error | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, roots: string[] = []) => {
      if (settled) return;
      settled = true;
      terminalError = error;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      // Passing the error destroys the connection, rather than returning a
      // client with an outstanding query to the pool.
      client?.release(error);
      if (error) reject(error);
      else resolve(roots);
    };
    const cancel = () => finish(new Error("Artifact root discovery cancelled"));
    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(
      () => finish(new Error("Artifact root discovery timed out")),
      3_000
    );
    timer.unref?.();
    void pool.connect().then(
      (acquired) => {
        if (settled) {
          acquired.release(terminalError);
          return;
        }
        client = acquired;
        void acquired
          .query<{
            files_dir: string;
          }>(
            "SELECT DISTINCT files_dir FROM agents WHERE files_dir IS NOT NULL"
          )
          .then(
            (result) =>
              finish(
                undefined,
                result.rows.map((row) => row.files_dir)
              ),
            (error: unknown) =>
              finish(
                error instanceof Error
                  ? error
                  : new Error("Artifact root discovery failed")
              )
          );
      },
      (error: unknown) =>
        finish(
          error instanceof Error
            ? error
            : new Error("Artifact root connection failed")
        )
    );
  });
}

export async function sampleRetainedArtifactStorage(
  pool: Pool,
  configuredRoots: string[],
  signal: AbortSignal,
  measure = sampleArtifactStorage
): Promise<number> {
  const roots = await discoverArtifactRoots(pool, signal);
  signal.throwIfAborted();
  return measure([...configuredRoots, ...roots], signal);
}
