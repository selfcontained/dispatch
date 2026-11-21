import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  isUpdateAttemptId,
  parseRetainedSessions,
  parseUpdateTarget,
} from "./protocol.js";
import type { FenceRecord, FenceStore } from "./update-admission.js";

/** Lives in the root updater's private state directory, beside its floor. */
export const RUNNER_UPDATE_FENCE_FILE = "fence.json";
const MAX_FENCE_BYTES = 256 * 1024;

export function parseFenceRecord(value: unknown): FenceRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const target = parseUpdateTarget(record.target);
  const retained = parseRetainedSessions(record.retained);
  if (
    record.format !== 1 ||
    !isUpdateAttemptId(record.attemptId) ||
    !target ||
    typeof record.retainSessions !== "boolean" ||
    !(
      record.phase === "fencing" ||
      record.phase === "fenced" ||
      record.phase === "activating"
    ) ||
    !retained
  )
    return null;
  return {
    format: 1,
    attemptId: record.attemptId,
    target,
    retainSessions: record.retainSessions,
    phase: record.phase,
    retained,
  };
}

async function trustedDirectory(dir: string, uid: number) {
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.uid !== uid || stat.mode & 0o077)
    throw new Error("Runner update state directory is not private");
}

async function syncDirectory(dir: string) {
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * The fence persisted in `<state>/fence.json`. Written atomically and synced
 * before the supervisor reports `fence_ready`, so a restarted supervisor or
 * a candidate build reads it before admitting anything.
 */
export function fileFenceStore(
  stateDir: string,
  trustedUid = process.getuid?.() ?? -1
): FenceStore {
  const file = path.join(stateDir, RUNNER_UPDATE_FENCE_FILE);
  return {
    async read() {
      // No file (or no updater directory) means no fence. Runners without
      // the updater keep their existing behaviour whatever the directory.
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      ).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!handle) return null;
      try {
        await trustedDirectory(stateDir, trustedUid);
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.uid !== trustedUid ||
          stat.mode & 0o077 ||
          stat.size > MAX_FENCE_BYTES
        )
          throw new Error("Runner update fence is not a private file");
        const record = parseFenceRecord(
          JSON.parse(await handle.readFile("utf8"))
        );
        if (!record) throw new Error("Runner update fence is malformed");
        return record;
      } finally {
        await handle.close();
      }
    },
    async write(record) {
      await trustedDirectory(stateDir, trustedUid);
      const temporary = path.join(
        stateDir,
        `.fence-${process.pid}-${randomBytes(8).toString("hex")}`
      );
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(record) + "\n");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      await syncDirectory(stateDir);
    },
    async clear() {
      await rm(file, { force: true });
      await syncDirectory(stateDir).catch(() => {});
    },
  };
}
