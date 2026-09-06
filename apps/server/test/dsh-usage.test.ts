import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildUsageReport,
  costUsd,
  createUsageReporter,
  fetchAnthropicCosts,
  fetchDeepSeekBalance,
  fetchOpenAiCosts,
  loadPriceTable,
  loggedUsage,
  monthStartUtc,
  type FetchLike,
} from "../src/agents/dsh/usage.js";

let tmp = "";
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = "";
});

const frame = (text: string) =>
  zstdCompressSync(text, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A dsh install layout: bin/dsh → lib/node_modules/@deepseek-ai/dsh/lib/bin.js, with pi-ai beside it. */
async function fakeDshInstall(root: string): Promise<string> {
  const pkg = path.join(root, "lib", "node_modules", "@deepseek-ai", "dsh");
  const data = path.join(
    pkg,
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "providers",
    "data"
  );
  await mkdir(path.join(pkg, "lib"), { recursive: true });
  await mkdir(data, { recursive: true });
  await mkdir(path.join(root, "bin"), { recursive: true });
  await writeFile(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh" })
  );
  await writeFile(path.join(pkg, "lib", "bin.js"), "");
  await writeFile(
    path.join(data, "openai.json"),
    JSON.stringify({
      "openai-responses": {
        "gpt-5.6-sol": {
          id: "gpt-5.6-sol",
          provider: "openai",
          cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
        },
      },
    })
  );
  await writeFile(
    path.join(data, "deepseek.json"),
    JSON.stringify({
      "openai-completions": {
        "deepseek-v4-flash": {
          id: "deepseek-v4-flash",
          provider: "deepseek",
          cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
        },
      },
    })
  );
  const bin = path.join(root, "bin", "dsh");
  await symlink(path.join(pkg, "lib", "bin.js"), bin);
  return bin;
}

describe("budgets and months", () => {
  it("starts the month at 00:00 UTC on the 1st", () => {
    expect(monthStartUtc(new Date("2026-09-05T23:00:00Z")).toISOString()).toBe(
      "2026-09-01T00:00:00.000Z"
    );
  });
});

describe("provider billing calls", () => {
  it("sums OpenAI's daily cost buckets with the admin key, following pages", async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push(url);
      expect(init?.headers?.Authorization).toBe("Bearer sk-admin");
      if (!url.includes("page=")) {
        return jsonResponse(200, {
          data: [
            { results: [{ amount: { value: 1.25, currency: "usd" } }] },
            {
              results: [
                { amount: { value: 0.5, currency: "usd" } },
                { amount: { value: 2, currency: "usd" } },
              ],
            },
          ],
          has_more: true,
          next_page: "p2",
        });
      }
      return jsonResponse(200, {
        data: [{ results: [{ amount: { value: 0.25 } }] }],
        has_more: false,
      });
    };
    const usd = await fetchOpenAiCosts(
      "sk-admin",
      new Date("2026-09-01T00:00:00Z"),
      fetchFn
    );
    expect(usd).toBe(4);
    expect(calls[0]).toContain("start_time=1788220800");
    expect(calls[0]).toContain("bucket_width=1d");
    expect(calls[1]).toContain("page=p2");
  });

  it("reports a failed OpenAI call by status", async () => {
    const fetchFn: FetchLike = async () => jsonResponse(401, { error: "nope" });
    await expect(fetchOpenAiCosts("bad", new Date(), fetchFn)).rejects.toThrow(
      /401/
    );
  });

  it("sums Anthropic's cost report from cents, with the admin headers", async () => {
    const fetchFn: FetchLike = async (url, init) => {
      expect(url).toContain(
        "/v1/organizations/cost_report?starting_at=2026-09-01T00%3A00%3A00.000Z"
      );
      expect(init?.headers?.["x-api-key"]).toBe("sk-ant-admin");
      expect(init?.headers?.["anthropic-version"]).toBe("2023-06-01");
      return jsonResponse(200, {
        data: [
          {
            results: [
              { amount: "123.45", currency: "USD" },
              { amount: "0.55", currency: "USD" },
            ],
          },
          { results: [] },
        ],
        has_more: false,
        next_page: null,
      });
    };
    expect(
      await fetchAnthropicCosts(
        "sk-ant-admin",
        new Date("2026-09-01T00:00:00Z"),
        fetchFn
      )
    ).toBeCloseTo(1.24, 6);
    const denied: FetchLike = async () => jsonResponse(403, {});
    await expect(fetchAnthropicCosts("k", new Date(), denied)).rejects.toThrow(
      /ANTHROPIC_ADMIN_KEY/
    );
  });

  it("reads DeepSeek's balance, preferring the USD line", async () => {
    const fetchFn: FetchLike = async (url, init) => {
      expect(url).toBe("https://api.deepseek.com/user/balance");
      expect(init?.headers?.Authorization).toBe("Bearer sk-ds");
      return jsonResponse(200, {
        is_available: true,
        balance_infos: [
          {
            currency: "CNY",
            total_balance: "7.00",
            granted_balance: "0.00",
            topped_up_balance: "7.00",
          },
          {
            currency: "USD",
            total_balance: "12.50",
            granted_balance: "2.50",
            topped_up_balance: "10.00",
          },
        ],
      });
    };
    expect(await fetchDeepSeekBalance("sk-ds", fetchFn)).toEqual({
      currency: "USD",
      total: 12.5,
      granted: 2.5,
      toppedUp: 10,
      available: true,
    });
  });
});

describe("prices and logs", () => {
  it("loads pi-ai's price table from the dsh install and prices token counts", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "dsh-usage-"));
    const bin = await fakeDshInstall(tmp);
    const table = await loadPriceTable(bin);
    expect(table.get("openai/gpt-5.6-sol")).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.4,
      cacheWrite: 5,
    });
    expect(await loadPriceTable(path.join(tmp, "missing"))).toEqual(new Map());
    expect(
      costUsd(
        {
          input: 1_000_000,
          output: 100_000,
          cacheRead: 0,
          cacheWrite: 200_000,
        },
        table.get("openai/gpt-5.6-sol")!
      )
    ).toBeCloseTo(4 + 2 + 1, 6);
  });

  it("sums this month's assistant usage per provider and model, skipping chunks and old logs", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "dsh-usage-"));
    const home = path.join(tmp, "home");
    const dir = path.join(
      home,
      "sessions",
      "--w--",
      "aaaaaaaa-0000-4000-8000-000000000001"
    );
    await mkdir(dir, { recursive: true });
    const sept = Date.UTC(2026, 8, 5);
    const aug = Date.UTC(2026, 7, 20);
    const msg = (
      time: number,
      provider: string,
      model: string,
      usage: Record<string, number>
    ) =>
      JSON.stringify({
        type: "assistant/message",
        time,
        data: {
          message: {
            role: "assistant",
            content: [],
            source: { kind: "model", provider, model },
          },
          usage,
        },
      }) + "\n";
    await writeFile(
      path.join(dir, "session.jsonl.zstd"),
      Buffer.concat([
        frame(
          '{"type":"session","version":0,"id":"aaaaaaaa-0000-4000-8000-000000000001"}\n'
        ),
        frame(
          JSON.stringify({
            type: "assistant/chunk",
            time: sept,
            data: { chunk: { type: "usage", usage: { inputTokens: 999 } } },
          }) +
            "\n" +
            msg(aug, "openai", "gpt-5.6-sol", {
              inputTokens: 5,
              outputTokens: 5,
            }) +
            msg(sept, "openai", "gpt-5.6-sol", {
              inputTokens: 3,
              outputTokens: 19,
              cacheWriteTokens: 12810,
            }) +
            msg(sept + 1, "openai", "gpt-5.6-sol", {
              inputTokens: 3,
              outputTokens: 25,
              cacheReadTokens: 12810,
              cacheWriteTokens: 1324,
            }) +
            msg(sept + 2, "deepseek-official", "deepseek-v4-flash", {
              inputTokens: 100,
              outputTokens: 50,
            })
        ),
      ])
    );
    const since = new Date(Date.UTC(2026, 8, 1));
    const usage = await loggedUsage(home, since);
    expect(usage.get("openai")?.get("gpt-5.6-sol")).toEqual({
      input: 6,
      output: 44,
      cacheRead: 12810,
      cacheWrite: 14134,
    });
    expect(usage.get("deepseek-official")?.get("deepseek-v4-flash")).toEqual({
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
    });

    const bin = await fakeDshInstall(tmp);
    const fetchFn: FetchLike = async (url) =>
      url.includes("openai")
        ? jsonResponse(200, {
            data: [{ results: [{ amount: { value: 3.5 } }] }],
          })
        : jsonResponse(200, {
            is_available: true,
            balance_infos: [
              {
                currency: "USD",
                total_balance: "9.00",
                granted_balance: "0",
                topped_up_balance: "9.00",
              },
            ],
          });
    const report = await buildUsageReport({
      env: {
        OPENAI_API_KEY: "k",
        OPENAI_ADMIN_KEY: "a",
        DEEPSEEK_API_KEY: "d",
      },
      dshHome: home,
      dshBin: bin,
      budgets: async () => ({ openai: 50, google: 5 }),
      fetchFn,
      now: () => new Date(Date.UTC(2026, 8, 5, 12)),
    });
    expect(report.monthStart).toBe("2026-09-01T00:00:00.000Z");
    // Keyed providers, plus Gemini for its budget alone.
    expect(report.providers.map((p) => p.id)).toEqual([
      "openai",
      "deepseek",
      "google",
    ]);
    const [openai, deepseek, google] = report.providers;
    expect(openai.budgetUsd).toBe(50);
    expect(openai.hasKey).toBe(true);
    expect(google).toMatchObject({ hasKey: false, budgetUsd: 5 });
    expect(google.error).toMatch(/GEMINI_API_KEY/);
    expect(openai.billed).toMatchObject({ usd: 3.5, source: "openai-costs" });
    expect(openai.logged.models[0].model).toBe("gpt-5.6-sol");
    // 6*4 + 44*20 + 12810*0.4 + 14134*5 per million
    expect(openai.logged.usd).toBeCloseTo((24 + 880 + 5124 + 70670) / 1e6, 9);
    expect(deepseek.balance).toMatchObject({ total: 9, currency: "USD" });
    expect(deepseek.logged.tokens).toEqual({
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(deepseek.logged.usd).toBeCloseTo((100 * 0.14 + 50 * 0.28) / 1e6, 12);
    expect(deepseek.budgetUsd).toBeNull();
  });

  it("names the missing admin key instead of failing the row, and caches the report", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "dsh-usage-"));
    const fetchFn = vi.fn<FetchLike>(async () => jsonResponse(500, {}));
    const reporter = createUsageReporter({
      env: { OPENAI_API_KEY: "k" },
      dshHome: path.join(tmp, "nowhere"),
      dshBin: path.join(tmp, "nobin"),
      budgets: async () => ({}),
      fetchFn,
    });
    const first = await reporter();
    expect(first.providers).toHaveLength(1);
    expect(first.providers[0].error).toMatch(/OPENAI_ADMIN_KEY/);
    expect(first.providers[0].billed).toBeUndefined();
    expect(first.providers[0].logged).toEqual({
      since: first.monthStart,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      usd: 0,
      models: [],
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await reporter()).toBe(first);
  });
});
