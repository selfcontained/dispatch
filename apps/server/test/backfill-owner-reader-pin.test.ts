import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
const database = vi.hoisted(() => ({ options: null as unknown }));
vi.mock("pg", () => {
  class Pool {
    constructor(options: unknown) {
      database.options = options;
    }
    async query() {
      return {
        rows: [
          {
            url: "https://github.com/t40/fixture/pull/1",
            stream_id: "fixture-agent",
            first_seen: "2026-01-01T00:00:00.000Z",
          },
        ],
      };
    }
    async end() {}
  }
  return { Pool, default: { Pool } };
});
vi.mock("../src/agents/merge-risk/sources.js", async (original) => ({
  ...(await original<typeof import("../src/agents/merge-risk/sources.js")>()),
  loadReviewEvidence: async () => [],
  loadBriefing: async () => "fixture briefing",
}));
vi.mock(
  "../../../packages/runner/src/workload/agents/remote/github-runner-executor.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../packages/runner/src/workload/agents/remote/github-runner-executor.js")
    >()),
    readPullRequestDetails: async () => ({
      number: 1,
      title: "Fixture PR",
      body: "Fixture body",
      baseRefName: "main",
      headRefName: "topic",
      headRefOid: "a".repeat(40),
      additions: 1,
      deletions: 0,
      state: "OPEN",
      mergedAt: null,
      statusCheckRollup: [],
      files: [{ path: "src/service.ts", additions: 1, deletions: 0 }],
    }),
  })
);
it("pins maintenance output with an explicit own-machine ownership fixture", async () => {
  const root = await mkdtemp("/tmp/backfill-owners-");
  const out = path.join(root, "output.json");
  await mkdir(path.join(root, ".agents"));
  await writeFile(
    path.join(root, ".agents/owners.json"),
    JSON.stringify({
      version: 1,
      rules: [{ paths: ["src/**"], personas: ["fixture-owner"] }],
    })
  );
  const argv = process.argv;
  let stdout = "",
    stderr = "";
  const writes = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
  const errors = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
  try {
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
    process.argv = [
      argv[0]!,
      "backfill-merge-risk.ts",
      "--database-url",
      "postgres://unused.invalid/fixture",
      "--repo",
      "t40/fixture",
      "--owners-root",
      root,
      "--out",
      out,
    ];
    await import("../../../scripts/backfill-merge-risk.ts");
    const output = await readFile(out, "utf8");
    expect(database.options).toMatchObject({
      options: "-c default_transaction_read_only=on",
    });
    expect(JSON.parse(output).ownersRoot).toBe(root);
    expect(
      JSON.parse(output).fixtures[0].evidence.change_summary.subsystems
    ).toEqual({ "fixture-owner": 1 });
    expect({
      stdout: stdout.replaceAll(root, "<root>"),
      stderr,
      output: output.replaceAll(root, "<root>"),
    }).toMatchInlineSnapshot(`
      {
        "output": "{
        "generatedAt": "2026-01-02T03:04:05.000Z",
        "repo": "t40/fixture",
        "since": "2026-01-01",
        "ownersRoot": "<root>",
        "count": 1,
        "skipped": [],
        "fixtures": [
          {
            "id": "pr-1",
            "prNumber": 1,
            "url": "https://github.com/t40/fixture/pull/1",
            "state": "OPEN",
            "mergedAt": null,
            "streams": [
              "fixture-agent"
            ],
            "evidence": {
              "pull_request": {
                "number": 1,
                "title": "Fixture PR",
                "description": "Fixture body",
                "base": "main",
                "head": "topic",
                "additions": 1,
                "deletions": 0,
                "files_changed": 1
              },
              "change_summary": {
                "subsystems": {
                  "fixture-owner": 1
                },
                "uncovered_files": 0,
                "flags": {
                  "migrations": 0,
                  "tests": 0,
                  "docs": 0,
                  "ci_config": 0,
                  "dependencies": 0,
                  "deletions": 0
                },
                "non_test_lines": {
                  "added": 1,
                  "deleted": 0
                }
              },
              "files": [
                "src/service.ts (+1/-0)"
              ],
              "briefing": "fixture briefing",
              "reviews": [],
              "ci": {
                "status": "none",
                "total": 0,
                "passed": 0,
                "failed": 0,
                "pending": 0
              }
            },
            "bytes": 501,
            "meta": {
              "reviews": 0,
              "findings": 0,
              "cleanReviews": 0,
              "subsystems": [
                "fixture-owner"
              ],
              "flags": {
                "migrations": 0,
                "tests": 0,
                "docs": 0,
                "ci_config": 0,
                "dependencies": 0,
                "deletions": 0
              }
            }
          }
        ]
      }
      ",
        "stderr": "",
        "stdout": "Found 1 pull requests for t40/fixture since 2026-01-01.
      {
        "out": "<root>/output.json",
        "fixtures": 1,
        "skipped": 0,
        "states": {
          "OPEN": 1
        },
        "bytes": {
          "max": 501,
          "median": 501
        },
        "withReviews": 0,
        "withBriefing": 1,
        "withCi": 1
      }
      ",
      }
    `);
  } finally {
    process.argv = argv;
    vi.useRealTimers();
    writes.mockRestore();
    errors.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
