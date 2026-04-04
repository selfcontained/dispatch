import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import type { Pool } from "pg";

import type { AgentRecord } from "./manager.js";

type ModelTokenTotals = {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  messageCount: number;
};

type SessionTokenSummary = {
  sessionId: string;
  totals: Map<string, ModelTokenTotals>;
  sessionStart: string | null;
  sessionEnd: string | null;
};

type HarvestAgent = Pick<AgentRecord, "id" | "type" | "cwd" | "worktreePath"> & {
  /**
   * When set, only harvest these specific session IDs (positive filter).
   * Used when multiple agents share the same Claude project directory
   * (e.g. persona + parent) so each only counts its own sessions.
   */
  ownedSessionIds?: string[];
};

type HarvestLogger = { warn: (obj: Record<string, unknown>, msg: string) => void };

const UPSERT_SQL = `INSERT INTO agent_token_usage
  (agent_id, session_id, model, input_tokens, cache_creation_tokens, cache_read_tokens,
   output_tokens, message_count, session_start, session_end)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
 ON CONFLICT (agent_id, session_id, model)
 DO UPDATE SET
   input_tokens = EXCLUDED.input_tokens,
   cache_creation_tokens = EXCLUDED.cache_creation_tokens,
   cache_read_tokens = EXCLUDED.cache_read_tokens,
   output_tokens = EXCLUDED.output_tokens,
   message_count = EXCLUDED.message_count,
   session_start = EXCLUDED.session_start,
   session_end = EXCLUDED.session_end,
   harvested_at = NOW()`;

// ── Claude Code harvesting ────────────────────────────────────────

function claudeProjectRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** Map an agent's working directory to the current Claude projects directory encoding. */
export function cwdToClaudeProjectDir(cwd: string): string {
  const encoded = cwd.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
  return path.join(claudeProjectRoot(), encoded);
}

export async function discoverSessionFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f));
}

async function parseClaudeSessionTokenUsage(filePath: string): Promise<SessionTokenSummary> {
  const sessionId = path.basename(filePath, ".jsonl");
  const totals = new Map<string, ModelTokenTotals>();
  let sessionStart: string | null = null;
  let sessionEnd: string | null = null;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== "assistant") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message?.usage) continue;

    const usage = message.usage as Record<string, number>;
    const model = (message.model as string) ?? "unknown";
    const ts = entry.timestamp as string | undefined;

    if (ts) {
      if (!sessionStart) sessionStart = ts;
      sessionEnd = ts;
    }

    let bucket = totals.get(model);
    if (!bucket) {
      bucket = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, messageCount: 0 };
      totals.set(model, bucket);
    }

    bucket.inputTokens += usage.input_tokens ?? 0;
    bucket.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
    bucket.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    bucket.outputTokens += usage.output_tokens ?? 0;
    bucket.messageCount += 1;
  }

  return { sessionId, totals, sessionStart, sessionEnd };
}

async function harvestClaudeTokenUsage(
  pool: Pool,
  agent: HarvestAgent,
  logger?: HarvestLogger
): Promise<void> {
  const effectiveCwd = agent.worktreePath ?? agent.cwd;
  const projectDir = cwdToClaudeProjectDir(effectiveCwd);
  let files = await discoverSessionFiles(projectDir);
  if (files.length === 0) return;

  // When multiple agents share the same cwd (e.g. persona + parent), only
  // harvest sessions that belong to this specific agent.
  if (agent.ownedSessionIds) {
    const owned = new Set(agent.ownedSessionIds);
    files = files.filter((f) => owned.has(path.basename(f, ".jsonl")));
    if (files.length === 0) return;
  }

  for (const file of files) {
    try {
      const summary = await parseClaudeSessionTokenUsage(file);

      for (const [model, t] of summary.totals) {
        if (t.messageCount === 0) continue;

        await pool.query(UPSERT_SQL, [
          agent.id,
          summary.sessionId,
          model,
          t.inputTokens,
          t.cacheCreationTokens,
          t.cacheReadTokens,
          t.outputTokens,
          t.messageCount,
          summary.sessionStart,
          summary.sessionEnd,
        ]);
      }
    } catch (err) {
      logger?.warn({ err, file }, "Failed to parse Claude session file for token usage");
    }
  }
}

// ── Codex harvesting ──────────────────────────────────────────────

const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const DISPATCH_TAG_RE = /\[dispatch:(agt_[a-z0-9_]+)\]/;

type CodexTokenUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

/**
 * Recursively discover all rollout JSONL files under ~/.codex/sessions/.
 * Files are organized as YYYY/MM/DD/rollout-*.jsonl.
 */
async function discoverCodexRolloutFiles(): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true }) as import("node:fs").Dirent[];
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

  await walk(CODEX_SESSIONS_DIR);
  return files;
}

/**
 * Parse a Codex rollout JSONL in a single pass: check for the agent tag
 * in the first 20 lines, then extract model and cumulative token usage.
 * Returns null if the file doesn't belong to the given agent or has no token data.
 */
async function parseCodexRolloutForAgent(
  filePath: string,
  agentId: string
): Promise<{ usage: CodexTokenUsage; model: string; sessionStart: string | null; sessionEnd: string | null } | null> {
  let matched = false;
  let lastUsage: CodexTokenUsage | null = null;
  let model = "unknown";
  let sessionStart: string | null = null;
  let sessionEnd: string | null = null;
  let linesRead = 0;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    linesRead++;

    // Check for agent tag in the first 20 lines
    if (!matched) {
      if (linesRead > 20) break;
      const tagMatch = DISPATCH_TAG_RE.exec(line);
      if (tagMatch && tagMatch[1] === agentId) matched = true;
      continue;
    }

    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = entry.timestamp as string | undefined;
    if (ts && !sessionStart) sessionStart = ts;
    if (ts) sessionEnd = ts;

    if (entry.type === "turn_context") {
      const payload = entry.payload as Record<string, unknown> | undefined;
      if (payload?.model) model = payload.model as string;
    }

    if (entry.type === "event_msg") {
      const payload = entry.payload as Record<string, unknown> | undefined;
      if (payload?.type === "token_count") {
        const info = payload.info as Record<string, unknown> | undefined;
        if (info?.total_token_usage) {
          lastUsage = info.total_token_usage as CodexTokenUsage;
        }
      }
    }
  }

  if (!matched || !lastUsage) return null;
  return { usage: lastUsage, model, sessionStart, sessionEnd };
}

async function harvestCodexTokenUsage(
  pool: Pool,
  agent: HarvestAgent,
  logger?: HarvestLogger
): Promise<void> {
  const rolloutFiles = await discoverCodexRolloutFiles();
  if (rolloutFiles.length === 0) return;

  for (const file of rolloutFiles) {
    try {
      const result = await parseCodexRolloutForAgent(file, agent.id);
      if (!result) continue;

      const { usage, model, sessionStart, sessionEnd } = result;
      const sessionId = path.basename(file, ".jsonl");

      // Normalize to additive model: cached_input_tokens is a subset of input_tokens
      const nonCachedInput = usage.input_tokens - (usage.cached_input_tokens ?? 0);
      const cachedInput = usage.cached_input_tokens ?? 0;

      await pool.query(UPSERT_SQL, [
        agent.id,
        sessionId,
        model,
        nonCachedInput,
        0, // cache_creation_tokens (N/A for Codex)
        cachedInput,
        usage.output_tokens,
        1, // message_count: Codex gives cumulative totals, count as 1 session
        sessionStart,
        sessionEnd,
      ]);
    } catch (err) {
      logger?.warn({ err, file }, "Failed to parse Codex rollout for token usage");
    }
  }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Harvest token usage for an agent based on its type.
 * Claude agents: parse ~/.claude/projects/ JSONL session logs.
 * Codex agents: find matching rollout files in ~/.codex/sessions/.
 */
export async function harvestTokenUsage(
  pool: Pool,
  agent: HarvestAgent,
  logger?: HarvestLogger
): Promise<void> {
  if (agent.type === "codex") {
    await harvestCodexTokenUsage(pool, agent, logger);
  } else if (agent.type === "claude") {
    await harvestClaudeTokenUsage(pool, agent, logger);
  }
  // opencode: no token tracking support yet
}
