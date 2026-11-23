import { afterAll, describe, expect, it } from "vitest";
import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp({
  env: {
    DISPATCH_RUNNER_HOST: "127.0.0.1",
    DISPATCH_RUNNER_PORT: "0",
    DISPATCH_RUNNER_ENDPOINT_HOST: "127.0.0.1",
  },
});

afterAll(() => {
  delete process.env.DISPATCH_RUNNER_HOST;
  delete process.env.DISPATCH_RUNNER_PORT;
  delete process.env.DISPATCH_RUNNER_ENDPOINT_HOST;
});

describe("runner control API", () => {
  it("exposes artifacts to unenrolled clients while protecting the installer command", async () => {
    const artifacts = await ctx.app.inject(
      "/api/v1/runner-artifacts/deadbeef/descriptor-linux-x64.json"
    );
    expect(artifacts.statusCode).toBe(404);
    expect(artifacts.json().error).toContain("running revision");
    const command = await ctx.app.inject("/api/v1/runners/installer");
    expect(command.statusCode).toBe(401);
  });

  it("requires normal API authentication", async () => {
    for (const [method, url] of [
      ["GET", "/api/runners"],
      ["POST", "/api/runners"],
      ["POST", "/api/runners/rnr_x/update"],
      ["POST", "/api/v1/runners/rnr_x/update"],
      ["DELETE", "/api/runners/rnr_x"],
      ["POST", "/api/runners/revoked/clear"],
      ["GET", "/api/v1/runners"],
      ["GET", "/api/v1/runners/rnr_x/github"],
      ["POST", "/api/v1/runners/rnr_x/github/login"],
      ["DELETE", "/api/v1/runners/rnr_x/github/login"],
      ["DELETE", "/api/v1/runners/rnr_x/github"],
      ["GET", "/api/v1/runners/rnr_x/repository-search?q=org/repo"],
      ["GET", "/api/v1/runners/rnr_x/pull-request-head"],
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        payload: method === "POST" ? { name: "a" } : undefined,
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("rejects scoped MCP tokens and sets no-store on GitHub account replies", async () => {
    const url = "/api/v1/runners/rnr_missing/github";
    const hostToken = await ctx.auth.getOrCreateAuthToken(ctx.pool);
    const scoped = ctx.auth.createAgentMcpToken(hostToken, "agt_fixture");
    const denied = await ctx.app.inject({
      url,
      headers: { authorization: `Bearer ${scoped}` },
    });
    expect(denied.statusCode).toBe(401);
    const permitted = await ctx.app.inject({
      url,
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(permitted.headers["cache-control"]).toBe("no-store");
    expect(permitted.json().status).toBe("unavailable");
  });

  it("lets only an operator start a runner update", async () => {
    const url = "/api/v1/runners/rnr_missing/update";
    const hostToken = await ctx.auth.getOrCreateAuthToken(ctx.pool);
    const scoped = ctx.auth.createAgentMcpToken(hostToken, "agt_fixture");
    for (const payload of [
      { action: "update" },
      { action: "force" },
      { action: "cancel", attemptId: crypto.randomUUID() },
    ]) {
      const denied = await ctx.app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${scoped}` },
        payload,
      });
      expect(denied.statusCode).toBe(401);
    }
    const cookie = await ctx.sessionCookie();
    for (const payload of [
      {},
      { action: "force", attemptId: 7 },
      { action: "drain" },
    ]) {
      const invalid = await ctx.app.inject({
        method: "POST",
        url,
        headers: { cookie },
        payload,
      });
      expect(invalid.statusCode).toBe(400);
    }
    for (const action of ["update", "force"]) {
      const missing = await ctx.app.inject({
        method: "POST",
        url,
        headers: { cookie },
        payload: { action },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({
        error: "Runner not found.",
        code: "not_found",
      });
    }
  });

  it("creates, lists and revokes a registration", async () => {
    const cookie = await ctx.sessionCookie();
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/runners",
      headers: { cookie },
      payload: { name: "lima" },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      id: string;
      command: string;
      expiresAt: string;
    };
    expect(Object.keys(body).sort()).toEqual(["command", "expiresAt", "id"]);
    expect(body.command).toContain("--endpoint https://127.0.0.1:");

    const bad = await ctx.app.inject({
      method: "POST",
      url: "/api/runners",
      headers: { cookie },
      payload: { name: " padded" },
    });
    expect(bad.statusCode).toBe(400);
    const duplicate = await ctx.app.inject({
      method: "POST",
      url: "/api/runners",
      headers: { cookie },
      payload: { name: "lima" },
    });
    expect(duplicate.statusCode).toBe(409);

    const listed = await ctx.app.inject({
      method: "GET",
      url: "/api/runners",
      headers: { cookie },
    });
    expect(listed.json()).toEqual({
      runners: [
        {
          id: body.id,
          name: "lima",
          status: "pending",
          automaticUpdates: true,
          engineManagement: false,
          githubManagement: false,
          workspaces: [],
        },
      ],
    });

    const renewal = await ctx.app.inject({
      method: "POST",
      url: `/api/runners/${body.id}/pair`,
      headers: { cookie },
    });
    expect(renewal.statusCode).toBe(201);
    expect(renewal.json().id).toBe(body.id);
    const unauthenticatedRenewal = await ctx.app.inject({
      method: "POST",
      url: `/api/runners/${body.id}/pair`,
    });
    expect(unauthenticatedRenewal.statusCode).toBe(401);

    const revoked = await ctx.app.inject({
      method: "DELETE",
      url: `/api/runners/${body.id}`,
      headers: { cookie },
    });
    expect(revoked.json()).toEqual({ ok: true });
    const after = await ctx.app.inject({
      method: "GET",
      url: "/api/runners",
      headers: { cookie },
    });
    expect(after.json().runners[0].status).toBe("revoked");
    const missing = await ctx.app.inject({
      method: "DELETE",
      url: "/api/runners/rnr_missing",
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("clears only selected revoked runners and keeps historical agent placement resolvable", async () => {
    const cookie = await ctx.sessionCookie();
    const revoked = "rnr_cleared_fixture";
    const otherRevoked = "rnr_other_revoked_fixture";
    const pending = "rnr_pending_fixture";
    const offline = "rnr_offline_fixture";
    const agentId = "agt_historical_fixture";
    const cwd = "/srv/checkout";
    await ctx.pool.query(
      `INSERT INTO runner_registrations
        (id, name, endpoint_host, revoked_at, enrolled_at, code_expires_at)
       VALUES ($1, 'History machine', 'localhost', now(), NULL, now() - interval '1 day'),
              ($2, 'Other revoked machine', 'localhost', now(), now(), NULL),
              ($3, 'Pending machine', 'localhost', NULL, NULL, now() + interval '1 day'),
              ($4, 'Offline machine', 'localhost', NULL, now(), NULL)`,
      [revoked, otherRevoked, pending, offline]
    );
    await ctx.pool.query(
      `INSERT INTO agents (id, name, cwd, status, runner_id)
       VALUES ($1, 'Historical agent', $2, 'stopped', $3)`,
      [agentId, cwd, revoked]
    );

    const clear = () =>
      ctx.app.inject({
        method: "POST",
        url: "/api/runners/revoked/clear",
        headers: { cookie },
        payload: { ids: [revoked, pending, offline, "rnr_missing"] },
      });
    const cleared = await clear();
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ cleared: 1 });
    expect((await clear()).json()).toEqual({ cleared: 0 });

    const listed = await ctx.app.inject({
      url: "/api/runners",
      headers: { cookie },
    });
    const ids = listed.json().runners.map(({ id }: { id: string }) => id);
    expect(ids).not.toContain(revoked);
    expect(ids).toEqual(
      expect.arrayContaining([otherRevoked, pending, offline])
    );

    const agent = await ctx.app.inject({
      url: `/api/v1/agents/${agentId}`,
      headers: { cookie },
    });
    expect(agent.statusCode).toBe(200);
    expect(agent.json().agent.cwd).toBe(cwd);
    const historical = await ctx.app.inject({
      url: "/api/runners?includeCleared=true",
      headers: { cookie },
    });
    expect(agent.json().agent.placement).toEqual({ runner: revoked });
    expect(historical.json().runners).toContainEqual(
      expect.objectContaining({
        id: revoked,
        name: "History machine",
        status: "revoked",
      })
    );
  });
});
