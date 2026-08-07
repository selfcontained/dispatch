import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

function candidateStorePath(): string {
  return (
    process.env.DISPATCH_RELEASE_CANDIDATE_STORE_PATH ??
    path.join(os.homedir(), ".dispatch", "release-candidate.json")
  );
}

export type ReleaseCandidate = {
  tag: string;
  previousTag: string | null;
  activatedAt: string;
};

export async function readReleaseCandidate(): Promise<ReleaseCandidate | null> {
  try {
    const value: unknown = JSON.parse(
      await readFile(candidateStorePath(), "utf8")
    );
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.tag !== "string" ||
      typeof record.activatedAt !== "string" ||
      (record.previousTag !== null && typeof record.previousTag !== "string")
    ) {
      return null;
    }
    return record as ReleaseCandidate;
  } catch {
    return null;
  }
}

export async function writeReleaseCandidate(
  candidate: ReleaseCandidate
): Promise<void> {
  const filePath = candidateStorePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${process.pid}`;
  await writeFile(tempPath, JSON.stringify(candidate, null, 2) + "\n", "utf8");
  await rename(tempPath, filePath);
}

export async function clearReleaseCandidate(): Promise<void> {
  await rm(candidateStorePath(), { force: true });
}

/**
 * A candidate is deliberately promoted by the freshly started process, not
 * by the process that swapped the executable. Keeping this small operation
 * separate makes that crash boundary explicit and directly testable.
 */
export async function promoteHealthyReleaseCandidate(input: {
  expectedTag: string;
  writeReleaseStore: (record: {
    tag: string;
    deployedAt: string;
  }) => Promise<void>;
}): Promise<boolean> {
  const candidate = await readReleaseCandidate();
  if (candidate?.tag !== input.expectedTag) return false;
  await input.writeReleaseStore({
    tag: candidate.tag,
    deployedAt: new Date().toISOString(),
  });
  await clearReleaseCandidate();
  return true;
}
