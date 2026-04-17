import type { PoolClient } from "pg";

import { seedNow } from "./constants.js";

type TokenUsageRow = {
  agentId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  messageCount: number;
  sessionStartHoursAgo: number;
  sessionEndHoursAgo: number;
};

const ROWS: TokenUsageRow[] = [
  // Running main: recent activity, Opus-heavy
  {
    agentId: "seed-agent-running-main",
    sessionId: "seed-session-rm-1",
    model: "claude-opus-4-7",
    inputTokens: 42_000,
    cacheCreationTokens: 18_000,
    cacheReadTokens: 112_000,
    outputTokens: 9_800,
    messageCount: 28,
    sessionStartHoursAgo: 2,
    sessionEndHoursAgo: 0.25,
  },
  // Feature agent across two models
  {
    agentId: "seed-agent-running-feature",
    sessionId: "seed-session-rf-1",
    model: "claude-opus-4-7",
    inputTokens: 88_000,
    cacheCreationTokens: 32_000,
    cacheReadTokens: 205_000,
    outputTokens: 21_200,
    messageCount: 55,
    sessionStartHoursAgo: 12,
    sessionEndHoursAgo: 6,
  },
  {
    agentId: "seed-agent-running-feature",
    sessionId: "seed-session-rf-2",
    model: "claude-sonnet-4-6",
    inputTokens: 22_000,
    cacheCreationTokens: 7_500,
    cacheReadTokens: 64_000,
    outputTokens: 5_400,
    messageCount: 17,
    sessionStartHoursAgo: 5,
    sessionEndHoursAgo: 0.5,
  },
  // Blocked agent
  {
    agentId: "seed-agent-blocked",
    sessionId: "seed-session-blk",
    model: "claude-opus-4-7",
    inputTokens: 33_500,
    cacheCreationTokens: 12_200,
    cacheReadTokens: 80_000,
    outputTokens: 7_100,
    messageCount: 20,
    sessionStartHoursAgo: 4,
    sessionEndHoursAgo: 1,
  },
  // Waiting agent — smaller Haiku session
  {
    agentId: "seed-agent-waiting",
    sessionId: "seed-session-wait",
    model: "claude-haiku-4-5",
    inputTokens: 18_000,
    cacheCreationTokens: 4_000,
    cacheReadTokens: 28_000,
    outputTokens: 3_200,
    messageCount: 11,
    sessionStartHoursAgo: 3,
    sessionEndHoursAgo: 1.5,
  },
  // History agents — show token spend on recent completed work
  {
    agentId: "seed-agent-history-1",
    sessionId: "seed-session-h1-1",
    model: "claude-opus-4-7",
    inputTokens: 64_000,
    cacheCreationTokens: 21_000,
    cacheReadTokens: 140_000,
    outputTokens: 14_800,
    messageCount: 41,
    sessionStartHoursAgo: 48,
    sessionEndHoursAgo: 40,
  },
  {
    agentId: "seed-agent-history-2",
    sessionId: "seed-session-h2-1",
    model: "claude-sonnet-4-6",
    inputTokens: 31_000,
    cacheCreationTokens: 9_000,
    cacheReadTokens: 75_000,
    outputTokens: 6_300,
    messageCount: 19,
    sessionStartHoursAgo: 72,
    sessionEndHoursAgo: 68,
  },
];

function hoursAgo(now: Date, h: number): Date {
  return new Date(now.getTime() - h * 60 * 60 * 1000);
}

export async function seedTokenUsage(client: PoolClient): Promise<void> {
  const now = seedNow();
  for (const row of ROWS) {
    await client.query(
      `
      INSERT INTO agent_token_usage (
        agent_id, session_id, model,
        input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens,
        message_count, harvested_at, session_start, session_end
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9,$10)
      `,
      [
        row.agentId,
        row.sessionId,
        row.model,
        row.inputTokens,
        row.cacheCreationTokens,
        row.cacheReadTokens,
        row.outputTokens,
        row.messageCount,
        hoursAgo(now, row.sessionStartHoursAgo),
        hoursAgo(now, row.sessionEndHoursAgo),
      ]
    );
  }
}
