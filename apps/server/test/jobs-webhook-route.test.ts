import { beforeEach, describe, expect, it } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp();

async function createWebhookJob(
  name: string,
  webhookEnabled: boolean
): Promise<{ id: string; webhookSecret: string | null }> {
  const cookie = await ctx.sessionCookie();
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/jobs",
    headers: { cookie, "content-type": "application/json" },
    payload: {
      name,
      directory: "/tmp",
      prompt: "test prompt",
      webhookEnabled,
    },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  return { id: body.id, webhookSecret: body.webhookSecret };
}

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM job_runs");
  await ctx.pool.query("DELETE FROM jobs");
  await ctx.pool.query("DELETE FROM agents");
});

describe("POST /api/v1/jobs/webhook/:secret", () => {
  it("returns jobId and runId for a valid webhook secret", async () => {
    const job = await createWebhookJob("wh-route-ok", true);
    expect(job.webhookSecret).toBeTruthy();

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/jobs/webhook/${job.webhookSecret}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jobId).toBe(job.id);
    expect(body.runId).toBeTruthy();
  });

  it("returns 404 for an unknown secret", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/jobs/webhook/nonexistent-secret-value",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("not found"),
    });
  });

  it("returns 404 after disabling webhook (secret is cleared)", async () => {
    const job = await createWebhookJob("wh-route-disabled", true);
    const secret = job.webhookSecret!;

    const cookie = await ctx.sessionCookie();
    const disableRes = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/jobs",
      headers: { cookie, "content-type": "application/json" },
      payload: {
        name: "wh-route-disabled",
        directory: "/tmp",
        webhookEnabled: false,
      },
    });
    expect(disableRes.statusCode).toBe(200);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/jobs/webhook/${secret}`,
    });

    expect(res.statusCode).toBe(404);
  });

  it("does not require authentication", async () => {
    const job = await createWebhookJob("wh-no-auth", true);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/jobs/webhook/${job.webhookSecret}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().runId).toBeTruthy();
  });

  it("sets triggerSource to webhook on the created run", async () => {
    const job = await createWebhookJob("wh-trigger-src", true);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/jobs/webhook/${job.webhookSecret}`,
    });
    expect(res.statusCode).toBe(200);

    const runId = res.json().runId;
    const dbResult = await ctx.pool.query(
      `SELECT config FROM job_runs WHERE id = $1`,
      [runId]
    );
    expect(dbResult.rows[0].config.triggerSource).toBe("webhook");
  });
});
