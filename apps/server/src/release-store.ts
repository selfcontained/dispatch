import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { resolveConfiguredPath } from "./shared/lib/resolve-tilde.js";
import { statePath } from "./state-dir.js";

// Isolated dev stacks and E2E runs set DISPATCH_RELEASE_STORE_PATH to keep
// from reading the host's production release state. Default is the
// machine-scoped production path.
const RELEASE_STORE_PATH = resolveConfiguredPath(
  process.env.DISPATCH_RELEASE_STORE_PATH ?? statePath("release.json")
);

export type ReleaseRecord = {
  tag: string;
  deployedAt: string;
};

/**
 * The release tag a packaged build's own version stands for ("1.2.4" ->
 * "v1.2.4"), or null for anything that isn't a plain release version.
 * Installs that never write the release store (the Mac app updates itself)
 * still know what they are from this.
 */
export function packageVersionTag(version: string | null): string | null {
  const trimmed = version?.trim() ?? "";
  return /^\d+\.\d+\.\d+$/.test(trimmed) ? `v${trimmed}` : null;
}

export async function readReleaseStore(): Promise<ReleaseRecord | null> {
  try {
    const raw = await readFile(RELEASE_STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "tag" in parsed &&
      "deployedAt" in parsed &&
      typeof (parsed as Record<string, unknown>).tag === "string" &&
      typeof (parsed as Record<string, unknown>).deployedAt === "string"
    ) {
      return parsed as ReleaseRecord;
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeReleaseStore(record: ReleaseRecord): Promise<void> {
  await mkdir(path.dirname(RELEASE_STORE_PATH), { recursive: true });
  await writeFile(
    RELEASE_STORE_PATH,
    JSON.stringify(record, null, 2) + "\n",
    "utf-8"
  );
}
