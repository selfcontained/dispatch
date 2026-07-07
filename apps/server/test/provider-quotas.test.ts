import { describe, expect, it } from "vitest";

import {
  readClaudeAuthToken,
  readCodexAuthTokens,
} from "../src/provider-quotas/adapters.js";
import {
  parseClaudeUsageResponse,
  parseCodexUsageResponse,
} from "../src/provider-quotas/parsers.js";

describe("provider quota parsers", () => {
  it("maps Codex WHAM quota windows", () => {
    const fetchedAt = new Date("2026-07-06T12:00:00.000Z");
    const snapshots = parseCodexUsageResponse(
      {
        account_id: "acct_123",
        rate_limit: {
          primary_window: {
            used: 60,
            limit: 100,
            limit_window_seconds: 18_000,
            reset_at: "2026-07-06T17:00:00.000Z",
            buckets: [
              {
                id: "gpt-5",
                title: "GPT-5",
                used: 5,
                limit: 10,
              },
            ],
          },
          secondary_window: {
            used_percent: 0.25,
            window_minutes: 10_080,
            reset_at: "2026-07-13T12:00:00.000Z",
          },
          additional_rate_limits: [
            {
              id: "gpt-5",
              title: "GPT-5",
              current: 3,
              max: 4,
              period_minutes: 60,
              reset_time: "2026-07-06T13:00:00.000Z",
            },
          ],
        },
        credits: {
          flex: {
            title: "Flex credits",
            used: 2,
            limit: 8,
          },
        },
      },
      { accountLabel: "work", fetchedAt }
    );

    expect(snapshots).toHaveLength(5);
    expect(snapshots[0]).toMatchObject({
      provider: "codex",
      accountLabel: "work",
      accountId: "acct_123",
      source: "chatgpt-wham",
      windowId: "primary_window",
      title: "Primary window",
      usedPercent: 60,
      windowMinutes: 300,
      fetchedAt,
      status: "ok",
    });
    expect(snapshots[0]?.resetsAt?.toISOString()).toBe(
      "2026-07-06T17:00:00.000Z"
    );
    expect(
      snapshots.find((snapshot) => snapshot.windowId === "secondary_window")
    ).toMatchObject({
      windowId: "secondary_window",
      usedPercent: 25,
      windowMinutes: 10080,
    });
    expect(
      snapshots.find((snapshot) => snapshot.windowId === "primary_window:gpt-5")
    ).toMatchObject({
      windowId: "primary_window:gpt-5",
      title: "Primary window / GPT-5",
      usedPercent: 50,
    });
    expect(
      snapshots.find((snapshot) => snapshot.windowId === "gpt-5")
    ).toMatchObject({
      windowId: "gpt-5",
      title: "GPT-5",
      usedPercent: 75,
      windowMinutes: 60,
    });
    expect(
      snapshots.find((snapshot) => snapshot.windowId === "credits:flex")
    ).toMatchObject({
      windowId: "credits:flex",
      title: "Flex credits",
      usedPercent: 25,
    });
  });

  it("reads Codex token shapes from auth.json", () => {
    expect(
      readCodexAuthTokens({
        account_id: "acct_root",
        email: "user@example.com",
        tokens: {
          access_token: "token-redacted",
          refresh_token: "refresh-redacted",
        },
      })
    ).toEqual({
      accessToken: "token-redacted",
      accountId: "acct_root",
      accountLabel: "user@example.com",
    });
  });

  it("reads Claude token shapes from local config JSON", () => {
    expect(
      readClaudeAuthToken({
        claudeAiOauth: {
          accessToken: "claude-token-redacted",
        },
      })
    ).toBe("claude-token-redacted");
  });

  it("reads Claude Code oauthAccount token shapes", () => {
    expect(
      readClaudeAuthToken({
        oauthAccount: {
          accountUuid: "account-redacted",
          claudeAiOauth: {
            accessToken: "claude-token-redacted",
          },
        },
      })
    ).toBe("claude-token-redacted");
  });

  it("maps Claude OAuth quota windows", () => {
    const fetchedAt = new Date("2026-07-06T12:00:00.000Z");
    const snapshots = parseClaudeUsageResponse(
      {
        organization_id: "org_123",
        organization_name: "Dispatch",
        five_hour: {
          utilization: 0.7,
          duration_seconds: 18_000,
          resets_at: "2026-07-06T17:00:00.000Z",
        },
        seven_day_sonnet: {
          percent_used: 82.5,
          window_minutes: 10_080,
          reset_at: "2026-07-13T12:00:00.000Z",
        },
        seven_day_oauth_apps: {
          utilization: 0.12,
          resets_at: "2026-07-13T12:00:00.000Z",
        },
        limits: [
          {
            kind: "weekly",
            group: "model",
            percent: 0.5,
            resets_at: "2026-07-13T12:00:00.000Z",
            period_minutes: 10_080,
            scope: {
              model: {
                display_name: "Claude Opus 4",
              },
            },
          },
        ],
      },
      { fetchedAt, source: "anthropic-oauth-claude-code-keychain" }
    );

    expect(snapshots).toHaveLength(4);
    expect(snapshots[0]).toMatchObject({
      provider: "claude",
      accountLabel: "Dispatch",
      accountId: "org_123",
      source: "anthropic-oauth-claude-code-keychain",
      windowId: "five_hour",
      title: "Five Hour",
      usedPercent: 70,
      windowMinutes: 300,
      fetchedAt,
      status: "ok",
    });
    expect(snapshots[1]).toMatchObject({
      windowId: "seven_day_oauth_apps",
      usedPercent: 12,
    });
    expect(
      snapshots.find((snapshot) => snapshot.windowId === "seven_day_sonnet")
    ).toMatchObject({
      windowId: "seven_day_sonnet",
      usedPercent: 82.5,
    });
    expect(
      snapshots.find((snapshot) => snapshot.windowId.startsWith("limits:"))
    ).toMatchObject({
      title: "Model / Claude Opus 4",
      usedPercent: 50,
    });
  });
});
