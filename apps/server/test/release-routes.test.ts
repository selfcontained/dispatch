import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import {
  getTestDatabaseUrl,
  runTestMigrations,
  setupTestDb,
  teardownTestDb,
} from "./db/setup.js";

const { runCommandMock, evaluateMock } = vi.hoisted(() => ({
  runCommandMock: vi.fn(),
  evaluateMock: vi.fn(),
}));

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: runCommandMock,
}));

// `evaluatePendingMigrations` makes a real HTTPS call to GitHub via the
// tarball cache, which can't run in unit tests. Mock the evaluator
// directly so each test controls the pending-migrations result for the
// gate decision. Tests that don't override default to "no migrations,
// no errors" — i.e. fall through to the legacy `dispatch-update`-based
// gating that the suite was originally written against.
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

let pool: Pool;
let app: FastifyInstance;
let createSession: typeof import("../src/auth.js").createSession;
let sessionCookie: string;
let tempRoot: string;
let releaseStorePath: string;

const uncaughtExceptionFilter = (err: Error): void => {
  if (
    err instanceof TypeError &&
    err.message.includes("destroySoon is not a function")
  ) {
    return;
  }
  throw err;
};

beforeAll(async () => {
  process.prependListener("uncaughtException", uncaughtExceptionFilter);

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "dispatch-release-routes-"));
  releaseStorePath = path.join(tempRoot, "release.json");
  await mkdir(path.join(os.homedir(), ".dispatch", "server"), {
    recursive: true,
  });

  pool = await setupTestDb();
  await runTestMigrations();

  process.env.DATABASE_URL = getTestDatabaseUrl();
  process.env.DISPATCH_AGENT_RUNTIME = "inert";
  process.env.DISPATCH_PORT = "6771";
  process.env.DISPATCH_HOST = "127.0.0.1";
  process.env.DISPATCH_RELEASE_STORE_PATH = releaseStorePath;

  const auth = await import("../src/auth.js");
  ({ createSession } = auth);

  const serverModule = await import("../src/server.js");
  app = await serverModule.initializeApp({
    runMigrations: false,
    reconcileState: false,
  });

  const setupResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { password: "hunter2hunter2" },
  });
  expect(setupResponse.statusCode).toBe(200);
});

afterAll(async () => {
  const serverModule = await import("../src/server.js");
  await serverModule.closeApp();
  delete process.env.DISPATCH_AGENT_RUNTIME;
  delete process.env.DATABASE_URL;
  delete process.env.DISPATCH_PORT;
  delete process.env.DISPATCH_HOST;
  delete process.env.DISPATCH_RELEASE_STORE_PATH;
  await teardownTestDb();
  await rm(tempRoot, { recursive: true, force: true });
  await new Promise((resolve) => setTimeout(resolve, 600));
  process.off("uncaughtException", uncaughtExceptionFilter);
});

beforeEach(async () => {
  runCommandMock.mockReset();
  evaluateMock.mockReset();
  // Default: no pending migrations, no errors. Individual tests can
  // override to simulate a release that ships migrations or an
  // evaluator failure.
  evaluateMock.mockResolvedValue({
    pending: [],
    all: [],
    appliedIds: new Set(),
    errors: [],
  });
  await pool.query("DELETE FROM agent_events");
  await pool.query("DELETE FROM agents");
  await pool.query("DELETE FROM sessions");
  await writeReleaseStore({
    tag: "v0.18.0",
    deployedAt: "2026-04-01T00:00:00Z",
  });

  const session = await createSession(pool);
  const signed = (
    app as FastifyInstance & { signCookie: (value: string) => string }
  ).signCookie(session);
  sessionCookie = `dispatch_session=${signed}`;
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

    const response = await app.inject({
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

    const response = await app.inject({
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

    const response = await app.inject({
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

    const response = await app.inject({
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

    const response = await app.inject({
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

    const stateResponse = await app.inject({
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

    await app.inject({
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

    const response = await app.inject({
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
    const launchResp = await app.inject({
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
    const authToken = await auth.getOrCreateAuthToken(pool);
    const bearer = auth.createReleaseUpdateToken(authToken, agent.id);

    const updateResp = await app.inject({
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
    const stateResp = await app.inject({
      method: "GET",
      url: "/api/v1/release/assisted/state",
      headers: { cookie: sessionCookie },
    });
    expect(stateResp.json()).toMatchObject({
      state: { tag: "v0.19.0", metadata: { mode: "required" } },
    });

    await app.inject({
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

    const launchResp = await app.inject({
      method: "POST",
      url: "/api/v1/release/assisted/launch",
      headers: { cookie: sessionCookie, "content-type": "application/json" },
      payload: { tag: "v0.19.0" },
    });
    expect(launchResp.statusCode).toBe(201);
    const { agent } = launchResp.json() as { agent: { id: string } };

    const auth = await import("../src/auth.js");
    const authToken = await auth.getOrCreateAuthToken(pool);
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
      updateResp = await app.inject({
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
      await app.inject({
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

    const response = await app.inject({
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

    const response = await app.inject({
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

    const response = await app.inject({
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

    const response = await app.inject({
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

    const response = await app.inject({
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

    const response = await app.inject({
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

    const response = await app.inject({
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
}: {
  releaseList?: Array<{ tagName: string; isPrerelease: boolean }>;
  releaseViews?: Record<string, string>;
}) {
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
        return { exitCode: 0, stdout: "ADMIN\n", stderr: "" };
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
