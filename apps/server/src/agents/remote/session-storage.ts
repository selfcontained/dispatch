import { chown, mkdir } from "node:fs/promises";
import path from "node:path";

/** The supervisor-owned parent prevents workloads from replacing session roots. */
export async function prepareScratchSession(
  sessions: string,
  key: string,
  uid: number,
  gid: number
): Promise<string> {
  const cwd = path.join(sessions, key);
  await mkdir(cwd, { mode: 0o700, recursive: true });
  await chown(cwd, uid, gid);
  return cwd;
}
