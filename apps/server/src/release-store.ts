import os from "node:os";
import { resolveConfiguredPath } from "./shared/lib/resolve-tilde.js";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// Isolated dev stacks and E2E runs set DISPATCH_RELEASE_STORE_PATH to keep
// from reading the host's production release state. Default is the
// machine-scoped production path.
const RELEASE_STORE_PATH = resolveConfiguredPath(
  process.env.DISPATCH_RELEASE_STORE_PATH ??
    path.join(os.homedir(), ".dispatch", "release.json")
);

export type ReleaseRecord = {
  tag: string;
  deployedAt: string;
};

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
