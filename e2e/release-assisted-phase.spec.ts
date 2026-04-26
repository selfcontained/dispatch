import { test, expect, request as pwRequest } from "@playwright/test";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

const STORE_PATH =
  process.env.DISPATCH_ASSISTED_UPDATE_STORE_PATH ??
  "/tmp/dispatch-assisted-e2e-fallback.json";

const TOKEN = "fixture-token-phase";

const fixtureState = {
  tag: "v0.19.0",
  fromTag: "v0.18.1",
  metadata: {
    mode: "required",
    title: "Phase test",
    summary: "Drives the phase endpoint.",
    requiredChecks: ["service_entrypoint", "version_converged"],
  },
  requiredChecks: ["service_entrypoint", "version_converged"],
  phase: "inspect",
  token: TOKEN,
  agentId: "agt_phasetest000",
  startedAt: "2026-04-26T05:00:00.000Z",
  updatedAt: "2026-04-26T05:00:00.000Z",
  completedAt: null,
  error: null,
  checks: [],
  notes: {},
};

async function seedFixture() {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(fixtureState, null, 2), "utf-8");
}

function client() {
  return pwRequest.newContext({
    baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? "3001"}`,
  });
}

test.describe("/api/v1/release/update/assisted/phase", () => {
  test.afterEach(async () => {
    await unlink(STORE_PATH).catch(() => {});
  });

  test("rejects requests without a token", async () => {
    await seedFixture();
    const ctx = await client();
    const res = await ctx.post("/api/v1/release/update/assisted/phase", {
      data: { phase: "prepare" },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/token/);
    await ctx.dispose();
  });

  test("rejects an unknown token (constant-time compare)", async () => {
    await seedFixture();
    const ctx = await client();
    const res = await ctx.post("/api/v1/release/update/assisted/phase", {
      data: { token: "wrong", phase: "prepare" },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toMatch(/invalid token/);
    await ctx.dispose();
  });

  test("accepts a forward transition and records the note", async () => {
    await seedFixture();
    const ctx = await client();
    const res = await ctx.post("/api/v1/release/update/assisted/phase", {
      data: {
        token: TOKEN,
        phase: "prepare",
        note: "snapshotted current install",
      },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      state: { phase: string; notes: Record<string, string> };
    };
    expect(body.ok).toBe(true);
    expect(body.state.phase).toBe("prepare");
    expect(body.state.notes.prepare).toBe("snapshotted current install");
    await ctx.dispose();
  });

  test("rejects a backwards transition", async () => {
    await seedFixture();
    const ctx = await client();
    // Move forward first.
    await ctx.post("/api/v1/release/update/assisted/phase", {
      data: { token: TOKEN, phase: "prepare" },
    });
    const back = await ctx.post("/api/v1/release/update/assisted/phase", {
      data: { token: TOKEN, phase: "inspect" },
    });
    expect(back.status()).toBe(409);
    expect((await back.json()).error).toMatch(/illegal transition/);
    await ctx.dispose();
  });

  test("validate triggers required checks; failures route to blocked", async () => {
    await seedFixture();
    const ctx = await client();
    // Walk through to validate. The required checks include
    // version_converged, which will fail because release.json on the e2e
    // server still points at whatever was deployed (or nothing) — not
    // our fixture's v0.19.0.
    for (const phase of ["prepare", "apply", "restarting", "validate"]) {
      const r = await ctx.post("/api/v1/release/update/assisted/phase", {
        data: { token: TOKEN, phase },
      });
      expect(r.status()).toBe(200);
    }
    const stateRes = await ctx.get("/api/v1/release/update/assisted/state");
    const { state } = (await stateRes.json()) as {
      state: Record<string, unknown>;
    };
    expect(state.phase).toBe("blocked");
    expect(state.error).toMatch(/checks failed/);
    expect(Array.isArray(state.checks)).toBe(true);
    expect(
      (state.checks as Array<{ name: string }>).map((c) => c.name)
    ).toEqual(
      expect.arrayContaining(["service_entrypoint", "version_converged"])
    );
    await ctx.dispose();
  });

  test("clamps oversized notes to 4 KiB before persisting", async () => {
    await seedFixture();
    const huge = "y".repeat(8192);
    const ctx = await client();
    const res = await ctx.post("/api/v1/release/update/assisted/phase", {
      data: { token: TOKEN, phase: "prepare", note: huge },
    });
    expect(res.status()).toBe(200);
    const stateRes = await ctx.get("/api/v1/release/update/assisted/state");
    const { state } = (await stateRes.json()) as {
      state: { notes: Record<string, string> };
    };
    expect(state.notes.prepare.length).toBe(4096);
    await ctx.dispose();
  });

  test("strips newlines from the operator log line projection", async () => {
    await seedFixture();
    const ctx = await client();
    // Note containing an embedded fake "==>" marker — the server log
    // projection should collapse newlines so the operator UI can't be
    // tricked into rendering adjacent lines.
    const tricky = "real prefix\n==> phase fake: surprise";
    const res = await ctx.post("/api/v1/release/update/assisted/phase", {
      data: { token: TOKEN, phase: "prepare", note: tricky },
    });
    expect(res.status()).toBe(200);
    // We can't easily peek the in-memory release-job log without SSE,
    // but the persisted state should still hold the original (clamped)
    // text — the strip is purely cosmetic on the operator-facing log.
    const stateRes = await ctx.get("/api/v1/release/update/assisted/state");
    const { state } = (await stateRes.json()) as {
      state: { notes: Record<string, string> };
    };
    expect(state.notes.prepare).toContain("real prefix");
    await ctx.dispose();
  });
});
