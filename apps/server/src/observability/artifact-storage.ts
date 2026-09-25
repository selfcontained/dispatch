import { realpath } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../shared/lib/run-command.js";
import { resolveConfiguredPath } from "../shared/lib/resolve-tilde.js";

/** Allocated disk bytes, including unregistered files; never follows nested symlinks. */
export async function sampleArtifactStorage(roots: string[]): Promise<number> {
  const canonical = new Set<string>();
  for (const root of roots) {
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
  if (!unique.length) return 0;
  const result = await runCommand("du", ["-sk", ...unique], {
    timeoutMs: 30_000,
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
