import { execFile } from "node:child_process";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadProviderPlans } from "../src/agents/provider-plans.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));

afterEach(() => vi.restoreAllMocks());

describe("Claude Keychain lookup", () => {
  it("loads live usage even when the runtime reports an unknown username", async () => {
    vi.spyOn(os, "userInfo").mockReturnValue({
      ...os.userInfo(),
      username: "unknown",
    });
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout: string
      ) => void;
      callback(
        null,
        JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } })
      );
      return undefined as never;
    });
    const fetchUsage = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            five_hour: { utilization: 12, resets_at: null },
          })
        )
    );

    const report = await loadProviderPlans({
      platform: "darwin",
      homeDir: "/unused",
      env: {},
      codexFiles: async () => [],
      fetchUsage,
    });

    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      expect.objectContaining({ timeout: 5_000 }),
      expect.any(Function)
    );
    expect(fetchUsage).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      })
    );
    expect(report.providers[0]?.unavailableReason).toBeUndefined();
    expect(report.providers[0]?.windows[0]?.usedPercent).toBe(12);
  });
});
