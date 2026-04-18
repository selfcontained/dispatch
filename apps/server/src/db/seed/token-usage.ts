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

// Token usage for the two seeded sidebar agents, mixing models so the
// Activity page "By model" breakdown has something to render.
const ROWS: TokenUsageRow[] = [
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
