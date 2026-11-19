import { expect, it } from "vitest";
import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp({
  setupAuth: false,
  env: {
    DISPATCH_RUNNER_HOST: "127.0.0.1",
    DISPATCH_RUNNER_PORT: "0",
    DISPATCH_RUNNER_ENDPOINT_HOST: "127.0.0.1",
  },
});

it("lets passwordless operators use runner GitHub routes while rejecting scoped bearers", async () => {
  const hostToken = await ctx.auth.getOrCreateAuthToken(ctx.pool);
  const scoped = ctx.auth.createAgentMcpToken(hostToken, "agt_fixture");
  const base = "/api/v1/runners/rnr_missing";
  for (const [method, url, status] of [
    ["GET", `${base}/github`, 200],
    ["POST", `${base}/github/login`, 200],
    ["DELETE", `${base}/github/login`, 200],
    ["DELETE", `${base}/github`, 200],
    ["GET", `${base}/repository-search?q=org/repo`, 503],
    [
      "GET",
      `${base}/pull-request-head?url=https://github.com/org/repo/pull/1`,
      422,
    ],
  ] as const) {
    const operator = await ctx.app.inject({ method, url });
    expect(operator.statusCode, url).toBe(status);
    expect(operator.headers["cache-control"]).toBe("no-store");

    const agent = await ctx.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${scoped}` },
    });
    expect(agent.statusCode, url).toBe(401);

    const bearer = await ctx.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(bearer.statusCode, url).toBe(status);
  }
});
