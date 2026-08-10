import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * Root of the Codex rollout logs. Codex honours `CODEX_HOME` and falls back to
 * `~/.codex`, so we resolve it the same way the CLI does.
 */
export function codexSessionsDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  return path.join(codexHome || path.join(os.homedir(), ".codex"), "sessions");
}

/**
 * Dispatch stamps `[dispatch:<agentId>]` at the head of the launch guidance it
 * feeds every agent, which is how a rollout file on disk gets attributed back
 * to the agent that produced it.
 */
export const DISPATCH_TAG_RE = /\[dispatch:(agt_[a-z0-9_]+)\]/;

/** The tag lives in the opening prompt, so it always lands in the first few lines. */
const TAG_SCAN_LINES = 20;

/**
 * Recursively discover all rollout JSONL files under the Codex sessions dir.
 * Files are organized as YYYY/MM/DD/rollout-*.jsonl.
 */
export async function discoverCodexRolloutFiles(): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = (await readdir(dir, {
        withFileTypes: true,
      })) as import("node:fs").Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }

  await walk(codexSessionsDir());
  return files;
}

/**
 * Read the Codex session id out of a rollout's `session_meta` header, falling
 * back to the UUID suffix of the filename (`rollout-<ts>-<uuid>.jsonl`) when
 * the header can't be parsed.
 */
function sessionIdFromRollout(
  filePath: string,
  firstLine: string | null
): string | null {
  if (firstLine) {
    try {
      const entry = JSON.parse(firstLine) as Record<string, unknown>;
      const payload = entry.payload as Record<string, unknown> | undefined;
      const id = payload?.session_id ?? payload?.id;
      if (typeof id === "string" && id) return id;
    } catch {
      // fall through to the filename
    }
  }
  const uuid = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(
    path.basename(filePath, ".jsonl")
  );
  return uuid?.[1] ?? null;
}

/**
 * Return the Codex session id if this rollout belongs to `agentId`, else null.
 */
async function readRolloutSessionIdForAgent(
  filePath: string,
  agentId: string
): Promise<string | null> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let firstLine: string | null = null;
  let linesRead = 0;
  let matched = false;
  try {
    for await (const line of rl) {
      linesRead += 1;
      if (linesRead === 1) firstLine = line;
      const tagMatch = DISPATCH_TAG_RE.exec(line);
      if (tagMatch && tagMatch[1] === agentId) {
        matched = true;
        break;
      }
      if (linesRead >= TAG_SCAN_LINES) break;
    }
  } finally {
    rl.close();
  }

  return matched ? sessionIdFromRollout(filePath, firstLine) : null;
}

/**
 * Find the Codex session id to resume for an agent.
 *
 * Unlike Claude Code, the Codex CLI mints its own session id at launch, so
 * Dispatch can't pre-assign one — it has to be recovered from the rollout logs
 * afterwards. `codex resume <id>` appends to the same rollout file and keeps
 * the same id, so the id stays valid across any number of restarts.
 *
 * Scans newest-modified first and returns the first rollout carrying this
 * agent's `[dispatch:<agentId>]` tag, or null when the agent has no Codex
 * session on disk (never launched, logs pruned, different machine).
 */
export async function findCodexSessionId(
  agentId: string,
  opts: { notBefore?: Date | null } = {}
): Promise<string | null> {
  const files = await discoverCodexRolloutFiles();
  if (files.length === 0) return null;

  // A rollout can't predate the agent that produced it. Allow a day of slack so
  // clock skew between the DB and the filesystem can't hide a valid session.
  const floor = opts.notBefore
    ? opts.notBefore.getTime() - 24 * 60 * 60 * 1000
    : null;

  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  for (const file of files) {
    try {
      const info = await stat(file);
      if (floor !== null && info.mtimeMs < floor) continue;
      candidates.push({ file, mtimeMs: info.mtimeMs });
    } catch {
      continue;
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { file } of candidates) {
    try {
      const sessionId = await readRolloutSessionIdForAgent(file, agentId);
      if (sessionId) return sessionId;
    } catch {
      continue;
    }
  }

  return null;
}
