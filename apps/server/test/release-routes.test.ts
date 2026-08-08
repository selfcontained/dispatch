import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { useInjectApp } from "./helpers/inject-app.js";

const { runCommandMock, evaluateMock, ensureCachedTarballMock } = vi.hoisted(
  () => ({
    runCommandMock: vi.fn(),
    evaluateMock: vi.fn(),
    ensureCachedTarballMock: vi.fn(),
  })
);

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: runCommandMock,
}));

vi.mock("../src/update-migrations-evaluator.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/update-migrations-evaluator.js")
    >();
  return {
    ...actual,
    evaluatePendingMigrations: evaluateMock,
  };
});

vi.mock("../src/release-tarball-cache.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/release-tarball-cache.js")>();
  return { ...actual, ensureCachedTarball: ensureCachedTarballMock };
});

let sessionCookie: string;
const tempRoot = mkdtempSync(
  path.join(os.tmpdir(), "dispatch-release-routes-")
);
const releaseStorePath = path.join(tempRoot, "release.json");
const rootPackageVersion = (
  JSON.parse(
    readFileSync(
      path.resolve(import.meta.dirname, "../../../package.json"),
      "utf8"
    )
  ) as { version: string }
).version;
const packagedCurrentTag = `v${rootPackageVersion}`;

beforeAll(async () => {
  await mkdir(path.join(os.homedir(), ".dispatch", "server"), {
    recursive: true,
  });
});

const ctx = useInjectApp({
  env: { DISPATCH_RELEASE_STORE_PATH: releaseStorePath },
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  runCommandMock.mockReset();
  evaluateMock.mockReset();
  evaluateMock.mockResolvedValue({
    pending: [],
    all: [],
    appliedIds: new Set(),
    errors: [],
  });
  ensureCachedTarballMock.mockRejectedValue(
    new Error("artifact download disabled in route test")
  );
  await ctx.pool.query("DELETE FROM agent_events");
  await ctx.pool.query("DELETE FROM agents");
  await ctx.pool.query("DELETE FROM sessions");
  await writeReleaseStore({
    tag: "v0.18.0",
    deployedAt: "2026-04-01T00:00:00Z",
  });

  sessionCookie = await ctx.sessionCookie();
});

describe("release metadata route handling", () => {
  it("returns assisted metadata in /release/info when the release body is valid", async () => {
    mockReleaseCommands({
      releaseList: [{ tagName: "v0.19.0", isPrerelease: false }],
      releaseViews: {
        "v0.19.0": validReleaseView({
          body: releaseBody(
            JSON.stringify({
              mode: "required",
              title: "Bun runtime migration",
              summary: "Switch runtime from Node to Bun.",
              requiredChecks: ["service_restarted"],
              appliesFrom: "v0.18.0",
            })
          ),
        }),
      },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/release/info",
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      latestTag: "v0.19.0",
      updateAvailable: true,
      assistedRequired: true,
      assisted: {
        mode: "required",
        title: "Bun runtime migration",
        requiredChecks: ["service_restarted"],
        appliesFrom: "v0.18.0",
      },
    });
  });

  it("fails closed in /release/info when release metadata is malformed", async () => {
    mockReleaseCommands({
      releaseList: [{ tagName: "v0.19.0", isPrerelease: false }],
      releaseViews: {
        "v0.19.0": validReleaseView({
          body: releaseBody("{ not valid json }"),
        }),
      },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/release/info",
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining(
        "Latest release has malformed assisted-update metadata"
      ),
    });
  });

  it("evaluates pending migrations on /release/info for authenticated viewers without repo admin access", async () => {
    evaluateMock.mockResolvedValueOnce({
      pending: [
        {
          filename: "001-example.yaml",
          order: 1,
          manifest: {
            id: "example",
            title: "Example migration",
            summary: "Requires a manual follow-up step.",
          },
        },
      ],
      all: [],
      appliedIds: new Set(),
      errors: [],
    });
    mockReleaseCommands({
      viewerPermission: "WRITE",
      releaseList: [{ tagName: "v0.19.0", isPrerelease: false }],
      releaseViews: {
        "v0.19.0": validReleaseView({ body: "no fenced metadata" }),
      },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/release/info",
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      isAdmin: false,
      latestTag: "v0.19.0",
      updateAvailable: true,
      pendingMigrations: [
        {
          id: "example",
          title: "Example migration",
          summary: "Requires a manual follow-up step.",
        },
      ],
      migrationsError: null,
      assistedRequired: true,
    });
    expect(evaluateMock).toHaveBeenCalledWith(
      "v0.19.0",
      expect.objectContaining({ repo: "selfcontained/dispatch" })
    );
  });

  describe("admin unreleased-commit enrichment", () => {
    const authoringDir = "/srv/authoring-checkout";

    beforeEach(async () => {
      vi.stubEnv("DISPATCH_RELEASE_AUTHORING", "1");
      vi.stubEnv("DISPATCH_RELEASE_AUTHORING_REPO_DIR", authoringDir);
      // The fetch coalescer caches per-checkout results for its TTL;
      // clear it so each test observes its own fetch.
      const { authoringRemoteRefresher } =
        await import("../src/routes/release.js");
      authoringRemoteRefresher.reset();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("fetches origin/main in the authoring checkout before counting", async () => {
      mockReleaseCommands({
        releaseList: [{ tagName: "v0.19.0", isPrerelease: false }],
        releaseViews: {
          "v0.19.0": validReleaseView({ body: "no fenced metadata" }),
        },
      });
      const base = runCommandMock.getMockImplementation()!;
      runCommandMock.mockImplementation(async (cmd, args, opts) => {
        if (
          cmd === "git" &&
          args.includes("rev-parse") &&
          args.includes("--verify")
        ) {
          return { exitCode: 0, stdout: "abc123\n", stderr: "" };
        }
        if (cmd === "git" && args.includes("rev-list")) {
          return { exitCode: 0, stdout: "3", stderr: "" };
        }
        if (cmd === "git" && args.includes("log")) {
          return {
            exitCode: 0,
            stdout: [
              "1111111aaaaaaa\tfix: one",
              "2222222bbbbbbb\tfeat: two",
              "3333333ccccccc\tchore: three",
            ].join("\n"),
            stderr: "",
          };
        }
        return base(cmd, args, opts);
      });

      const response = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/release/info",
        headers: { cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        isAdmin: true,
        unreleasedCount: 3,
        refMissing: false,
        unreleasedFetchError: null,
        commits: [
          { sha: "1111111", subject: "fix: one" },
          { sha: "2222222", subject: "feat: two" },
          { sha: "3333333", subject: "chore: three" },
        ],
      });

      const gitCalls = runCommandMock.mock.calls.filter(
        (call): call is [string, string[]] => call[0] === "git"
      );
      const fetchCall = gitCalls.find(([, args]) => args.includes("fetch"));
      expect(fetchCall?.[1]).toEqual([
        "-C",
        authoringDir,
        "fetch",
        "--quiet",
        "--tags",
        "origin",
        "main",
      ]);
      const enrichmentCalls = gitCalls.filter(([, args]) =>
        ["rev-parse", "rev-list", "log"].some((sub) => args.includes(sub))
      );
      expect(enrichmentCalls.length).toBeGreaterThan(0);
      for (const [, args] of enrichmentCalls) {
        expect(args.slice(0, 2)).toEqual(["-C", authoringDir]);
      }
    });

    it("reports a fetch failure instead of zero unreleased commits", async () => {
      mockReleaseCommands({
        releaseList: [{ tagName: "v0.19.0", isPrerelease: false }],
        releaseViews: {
          "v0.19.0": validReleaseView({ body: "no fenced metadata" }),
        },
      });
      const base = runCommandMock.getMockImplementation()!;
      runCommandMock.mockImplementation(async (cmd, args, opts) => {
        if (cmd === "git" && args.includes("fetch")) {
          throw new Error(
            "Command failed (git fetch), exitCode=128, stderr=could not resolve host"
          );
        }
        return base(cmd, args, opts);
      });

      const response = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/release/info",
        headers: { cookie: sessionCookie },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { unreleasedFetchError: string };
      expect(body).toMatchObject({
        isAdmin: true,
        unreleasedCount: 0,
        refMissing: false,
        unreleasedFetchError: expect.stringContaining(
          "Unable to refresh origin/main"
        ),
      });
      // Sanitized: raw git stderr must not reach the client.
      expect(body.unreleasedFetchError).not.toContain("could not resolve host");
      const comparisonCalls = runCommandMock.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "git" &&
          ["rev-parse", "rev-list", "log"].some((sub) =>
            (args as string[]).includes(sub)
          )
      );
      expect(comparisonCalls).toHaveLength(0);
    });
  });

  it("falls back to the packaged app version when no release tag is recorded", async () => {
    await rm(releaseStorePath, { force: true });
    mockReleaseCommands({
      releaseList: [{ tagName: "v0.18.36", isPrerelease: false }],
      releaseViews: {
        "v0.18.36": validReleaseView({
          body: "no fenced metadata",
          tag: "v0.18.36",
        }),
      },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/release/info",
      headers: { cookie: sessionCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      currentTag: packagedCurrentTag,
      latestTag: "v0.18.36",
      updateAvailable: compareSemverForTest("v0.18.36", packagedCurrentTag) > 0,
    });
  });

  it("rejects /release/update when the target release requires assisted flow", async () => {
    mockReleaseCommands({
      releaseViews: {
        "v0.19.0": validReleaseView({
          body: releaseBody(
            JSON.stringify({
              mode: "required",
              title: "Bun runtime migration",
              summary: "Switch runtime from Node to Bun.",
              requiredChecks: [],
              appliesFrom: "v0.18.0",
            })
          ),
        }),
      },
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/update",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { tag: "v0.19.0" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "ASSISTED_UPDATE_REQUIRED",
      assisted: {
        mode: "required",
        title: "Bun runtime migration",
      },
    });
  });

  it("rejects /release/update when the target release metadata is malformed", async () => {
    mockReleaseCommands({
      releaseViews: {
        "v0.19.0": validReleaseView({
          body: releaseBody("{ not valid json }"),
        }),
      },
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/update",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { tag: "v0.19.0" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "ASSISTED_UPDATE_METADATA_INVALID",
    });
  });

  it("creates structured assisted-update state for valid metadata on /release/assisted/launch", async () => {
    mockReleaseCommands({
      releaseViews: {
        "v0.19.0": validReleaseView({
          body: releaseBody(
            JSON.stringify({
              mode: "required",
              title: "Bun runtime migration",
              summary: "Switch runtime from Node to Bun.",
              requiredChecks: ["service_restarted"],
              appliesFrom: "v0.18.0",
            })
          ),
        }),
      },
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/assisted/launch",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { tag: "v0.19.0" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      agent: {
        role: "assisted_update",
      },
      assisted: {
        tag: "v0.19.0",
        metadata: {
          title: "Bun runtime migration",
          mode: "required",
        },
        phase: "inspect",
      },
    });

    const stateResponse = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/release/assisted/state",
      headers: { cookie: sessionCookie },
    });
    expect(stateResponse.statusCode).toBe(200);
    expect(stateResponse.json()).toMatchObject({
      state: {
        tag: "v0.19.0",
        metadata: {
          title: "Bun runtime migration",
        },
      },
    });

    await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/release/assisted/state",
      headers: { cookie: sessionCookie },
    });
  });

  it("rejects /release/assisted/launch when the target release metadata is malformed", async () => {
    mockReleaseCommands({
      releaseViews: {
        "v0.19.0": validReleaseView({
          body: releaseBody("{ not valid json }"),
        }),
      },
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/assisted/launch",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { tag: "v0.19.0" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "ASSISTED_UPDATE_METADATA_INVALID",
    });
  });

  it("allows /release/update when called with the assisted agent's bearer (takeover)", async () => {
    mockReleaseCommands({
      releaseViews: {
        "v0.19.0": validReleaseView({
          body: releaseBody(
            JSON.stringify({
              mode: "required",
              title: "Bun runtime migration",
              summary: "Switch runtime from Node to Bun.",
              requiredChecks: [],
              appliesFrom: "v0.18.0",
            })
          ),
        }),
      },
    });

    // 1. Launch sets activeReleaseJob to update-assisted for v0.19.0
    //    and creates the agent that will own the bearer token.
    const launchResp = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/assisted/launch",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { tag: "v0.19.0" },
    });
    expect(launchResp.statusCode).toBe(201);
    const { agent } = launchResp.json() as { agent: { id: string } };

    // 2. Without the takeover carve-out, the agent's own /release/update
    //    call would 409 against its own active job. With the fix, it
    //    proceeds as a normal update kick-off (202).
    const auth = await import("../src/auth.js");
    const authToken = await auth.getOrCreateAuthToken(ctx.pool);
    const bearer = auth.createReleaseUpdateToken(authToken, agent.id);

    const updateResp = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/update",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      payload: { tag: "v0.19.0" },
    });

    expect(updateResp.statusCode).toBe(202);
    expect(updateResp.json()).toMatchObject({ ok: true });

    // 3. Assisted state on disk survives the takeover so the agent's
    //    later phase reports continue to update the canonical record.
    const stateResp = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/release/assisted/state",
      headers: { cookie: sessionCookie },
    });
    expect(stateResp.json()).toMatchObject({
      state: { tag: "v0.19.0", metadata: { mode: "required" } },
    });

    await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/release/assisted/state",
      headers: { cookie: sessionCookie },
    });
  });

  it("rejects /release/update when bearer's tag does not match the active assisted job", async () => {
    mockReleaseCommands({
      releaseViews: {
        "v0.19.0": validReleaseView({
          body: releaseBody(
            JSON.stringify({
              mode: "required",
              title: "Bun runtime migration",
              summary: "Switch runtime from Node to Bun.",
              requiredChecks: [],
              appliesFrom: "v0.18.0",
            })
          ),
        }),
      },
    });

    const launchResp = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/assisted/launch",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { tag: "v0.19.0" },
    });
    expect(launchResp.statusCode).toBe(201);
    const { agent } = launchResp.json() as { agent: { id: string } };

    const auth = await import("../src/auth.js");
    const authToken = await auth.getOrCreateAuthToken(ctx.pool);
    const bearer = auth.createReleaseUpdateToken(authToken, agent.id);

    // The bearer token resolves to an active assisted-update agent, but
    // the request asks to deploy a different tag than the one the agent
    // was launched for. The token is bound to the assisted run's tag
    // (CRU-146 review feedback #1235) — mismatched tags fail with 403
    // before reaching the takeover guard. This keeps a stale token from
    // bypassing the migration gate for an arbitrary tag once the
    // assisted job has terminated.
    let updateResp;
    try {
      updateResp = await ctx.app.inject({
        method: "POST",
        url: "/api/v1/release/update",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        payload: { tag: "v0.20.0" },
      });

      expect(updateResp.statusCode).toBe(403);
      expect(updateResp.json()).toMatchObject({
        error: expect.stringContaining(
          "Assisted update token is bound to a different tag"
        ),
      });
    } finally {
      // Always tear down the assisted job so a failed assertion doesn't
      // leak `activeReleaseJob` into the next test (which then 409s on
      // an unrelated active-job conflict).
      await ctx.app.inject({
        method: "DELETE",
        url: "/api/v1/release/assisted/state",
        headers: { cookie: sessionCookie },
      });
    }
  });

  it("fails closed with 503 when the migration evaluator throws", async () => {
    // Round-1 review #1239: the migration gate must NOT silently fall
    // through to the legacy path on evaluator failure — that inverts
    // the security posture once the legacy fence is removed. The
    // operator should see a clear "couldn't evaluate" error and retry.
    evaluateMock.mockRejectedValueOnce(
      new Error("simulated network failure fetching tarball")
    );
    mockReleaseCommands({
      releaseViews: {
        "v0.19.0": validReleaseView({
          body: releaseBody(
            JSON.stringify({
              mode: "normal",
              title: "x",
              summary: "x",
              requiredChecks: [],
            })
          ),
        }),
      },
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/update",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { tag: "v0.19.0" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: "MIGRATION_EVALUATION_UNAVAILABLE",
    });
  });

  it("rejects /release/update with ASSISTED_UPDATE_REQUIRED when migrations are pending", async () => {
    evaluateMock.mockResolvedValueOnce({
      pending: [
        {
          filename: "0001-bun-cutover.yaml",
          order: 1,
          manifest: {
            id: "bun-cutover",
            title: "Bun runtime cutover",
            summary: "Switch runtime from Node to Bun.",
            alreadySatisfied: { description: "x" },
            instructions: ["x"],
            validation: { requiredChecks: [] },
            rollback: [],
          },
        },
      ],
      all: [],
      appliedIds: new Set(),
      errors: [],
    });
    mockReleaseCommands({
      releaseViews: {
        "v0.19.0": validReleaseView({ body: "no fenced metadata" }),
      },
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/update",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { tag: "v0.19.0" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "ASSISTED_UPDATE_REQUIRED",
      pendingMigrations: [expect.objectContaining({ id: "bun-cutover" })],
    });
  });

  it("allows /release/update when the installed version is below appliesFrom", async () => {
    await writeReleaseStore({
      tag: "v0.17.5",
      deployedAt: "2026-04-01T00:00:00Z",
    });
    mockReleaseCommands({
      releaseViews: {
        "v0.19.0": validReleaseView({
          body: releaseBody(
            JSON.stringify({
              mode: "required",
              title: "Bun runtime migration",
              summary: "Switch runtime from Node to Bun.",
              requiredChecks: [],
              appliesFrom: "v0.18.0",
            })
          ),
        }),
      },
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/update",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { tag: "v0.19.0" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ ok: true });
  });

  it("allows /release/update with force=true to bypass mode=required gate", async () => {
    mockReleaseCommands({
      releaseViews: {
        "v0.19.0": validReleaseView({
          body: releaseBody(
            JSON.stringify({
              mode: "required",
              title: "Bun runtime migration",
              summary: "Switch runtime from Node to Bun.",
              requiredChecks: [],
              appliesFrom: "v0.18.0",
            })
          ),
        }),
      },
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/update",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { tag: "v0.19.0", force: true },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ ok: true });
  });

  it("allows /release/update with force=true to bypass pending-migrations gate", async () => {
    evaluateMock.mockResolvedValueOnce({
      pending: [
        {
          filename: "0001-bun-cutover.yaml",
          order: 1,
          manifest: {
            id: "bun-cutover",
            title: "Bun runtime cutover",
            summary: "Switch runtime from Node to Bun.",
            alreadySatisfied: { description: "x" },
            instructions: ["x"],
            validation: { requiredChecks: [] },
            rollback: [],
          },
        },
      ],
      all: [],
      appliedIds: new Set(),
      errors: [],
    });
    mockReleaseCommands({
      releaseViews: {
        "v0.19.0": validReleaseView({ body: "no fenced metadata" }),
      },
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/update",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { tag: "v0.19.0", force: true },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ ok: true });
  });

  it("allows /release/update with force=true to bypass migration evaluator failure", async () => {
    evaluateMock.mockRejectedValueOnce(
      new Error("simulated network failure fetching tarball")
    );
    mockReleaseCommands({
      releaseViews: {
        "v0.19.0": validReleaseView({
          body: releaseBody(
            JSON.stringify({
              mode: "normal",
              title: "x",
              summary: "x",
              requiredChecks: [],
            })
          ),
        }),
      },
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/update",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { tag: "v0.19.0", force: true },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ ok: true });
  });

  it("rejects /release/update with force=true when target metadata is malformed", async () => {
    // force=true should not bypass the malformed-metadata error — that's a
    // real correctness signal, not a "we couldn't check" signal.
    mockReleaseCommands({
      releaseViews: {
        "v0.19.0": validReleaseView({
          body: releaseBody("{ not valid json }"),
        }),
      },
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/release/update",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { tag: "v0.19.0", force: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "ASSISTED_UPDATE_METADATA_INVALID",
    });
  });
});

async function writeReleaseStore(record: {
  tag: string;
  deployedAt: string;
}): Promise<void> {
  await writeFile(
    releaseStorePath,
    JSON.stringify(record, null, 2) + "\n",
    "utf8"
  );
}

function releaseBody(block: string): string {
  return `Notes before.

\`\`\`dispatch-update
${block}
\`\`\`

Notes after.`;
}

function validReleaseView({
  body,
  tag = "v0.19.0",
}: {
  body: string | null;
  tag?: string;
}): string {
  return JSON.stringify({
    tagName: tag,
    publishedAt: "2026-04-26T00:00:00Z",
    url: `https://github.com/selfcontained/dispatch/releases/tag/${tag}`,
    body,
  });
}

function mockReleaseCommands({
  releaseList = [],
  releaseViews = {},
  viewerPermission = "ADMIN",
}: {
  releaseList?: Array<{ tagName: string; isPrerelease: boolean }>;
  releaseViews?: Record<string, string>;
  viewerPermission?: string;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/releases?per_page=20")) {
        return new Response(
          JSON.stringify(
            releaseList.map((release) => ({
              tag_name: release.tagName,
              published_at: "2026-04-26T00:00:00Z",
              html_url: `https://github.com/selfcontained/dispatch/releases/tag/${release.tagName}`,
              prerelease: release.isPrerelease,
              assets: [{ name: "dispatch-release.tar.gz" }],
            }))
          )
        );
      }
      const match = url.match(/\/releases\/tags\/([^/?]+)/);
      if (match) {
        const tag = decodeURIComponent(match[1]!);
        const raw = releaseViews[tag];
        if (!raw) return new Response("not found", { status: 404 });
        const view = JSON.parse(raw) as {
          tagName: string;
          publishedAt: string;
          url: string;
          body?: string | null;
        };
        return new Response(
          JSON.stringify({
            tag_name: view.tagName,
            published_at: view.publishedAt,
            html_url: view.url,
            body: view.body,
          })
        );
      }
      return new Response("unexpected URL", { status: 500 });
    })
  );
  runCommandMock.mockImplementation(
    async (
      cmd: string,
      args: string[],
      opts?: { allowedExitCodes?: number[] }
    ) => {
      if (cmd === "gh" && args[0] === "--version") {
        return { exitCode: 0, stdout: "gh 2.0.0\n", stderr: "" };
      }
      if (
        cmd === "git" &&
        args.includes("fetch") &&
        args.includes("origin") &&
        args.includes("--tags")
      ) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (
        cmd === "git" &&
        args.includes("remote") &&
        args.includes("get-url") &&
        args.includes("origin")
      ) {
        return {
          exitCode: 0,
          stdout: "git@github.com:selfcontained/dispatch.git\n",
          stderr: "",
        };
      }
      if (
        cmd === "gh" &&
        args[0] === "repo" &&
        args[1] === "view" &&
        args.includes("--jq")
      ) {
        return { exitCode: 0, stdout: `${viewerPermission}\n`, stderr: "" };
      }
      if (cmd === "gh" && args[0] === "release" && args[1] === "list") {
        return {
          exitCode: 0,
          stdout: JSON.stringify(releaseList),
          stderr: "",
        };
      }
      if (cmd === "gh" && args[0] === "release" && args[1] === "view") {
        const tag = args[2];
        const stdout = releaseViews[tag];
        if (!stdout) {
          throw new Error(`no mocked release view for ${tag}`);
        }
        return { exitCode: 0, stdout, stderr: "" };
      }
      if (
        cmd === "git" &&
        args.includes("rev-parse") &&
        args.includes("--verify")
      ) {
        return {
          exitCode: 128,
          stdout: "",
          stderr: "fatal: bad revision",
        };
      }
      if (
        cmd === "git" &&
        args.includes("tag") &&
        args.includes("--sort=-version:refname")
      ) {
        return { exitCode: 0, stdout: "v0.19.0\nv0.18.0\n", stderr: "" };
      }
      if (opts?.allowedExitCodes?.includes(128)) {
        return { exitCode: 128, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    }
  );
}

function compareSemverForTest(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number(part));
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
