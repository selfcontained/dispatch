#!/usr/bin/env bun

/**
 * Smoke test for the compiled Dispatch binary: it boots against a database,
 * migrates, serves the API with its auth token, and can create, list and
 * stop an agent. The runtime is `inert` (no engine process is attached), so
 * this needs no CLI on the machine; what it proves is that the binary's
 * embedded assets, migrations and routes are all there.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import pg from "pg";

const binaryPath = process.argv[2];
if (!binaryPath) {
  console.error("Usage: bun scripts/smoke-bun-binary.mjs <binary-path>");
  process.exit(1);
}

const runId = randomBytes(6).toString("hex");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-bun-smoke-"));
const port = Number(process.env.DISPATCH_SMOKE_PORT ?? 6878);
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://dispatch:dispatch@127.0.0.1:5432/postgres";

const child = spawn(binaryPath, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DISPATCH_HOST: "127.0.0.1",
    DISPATCH_PORT: String(port),
    DISPATCH_AGENT_RUNTIME: "inert",
    DISPATCH_AGENT_STATE_ROOT: path.join(tempRoot, "agents"),
    DISPATCH_FILES_ROOT: path.join(tempRoot, "files"),
    DISPATCH_RELEASE_STORE_PATH: path.join(tempRoot, "release.json"),
    TLS_CERT: "",
    TLS_KEY: "",
  },
  stdio: "inherit",
});

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error("Timed out waiting for Dispatch health endpoint");
}

async function getAuthToken() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const token = result.rows[0]?.value;
    if (!token) {
      throw new Error("auth_token setting was not created");
    }
    return token;
  } finally {
    await client.end().catch(() => null);
  }
}

async function api(pathname, init = {}, token) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(
      `${pathname} failed: ${response.status} ${await response.text()}`
    );
  }
  return response;
}

/** The agent once its launch has settled: anything but `creating`. */
async function waitForLaunched(agentId, token) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await api(`/api/v1/agents/${agentId}`, {}, token);
    const { agent } = await response.json();
    if (agent?.status && agent.status !== "creating") return agent;
    await Bun.sleep(250);
  }
  throw new Error(`Agent ${agentId} never left the creating state`);
}

async function main() {
  try {
    await waitForHealth();
    const token = await getAuthToken();

    const createResponse = await api(
      "/api/v1/agents",
      {
        method: "POST",
        body: JSON.stringify({
          name: `bun-smoke-${runId}`,
          cwd: "/tmp",
          type: "codex",
          useWorktree: false,
        }),
      },
      token
    );
    const { agent: created } = await createResponse.json();
    const agent = await waitForLaunched(created.id, token);
    if (agent.status === "error") {
      throw new Error(`Agent launch failed: ${agent.lastError ?? "unknown"}`);
    }

    const listResponse = await api("/api/v1/agents", {}, token);
    const { agents } = await listResponse.json();
    if (!agents.some((row) => row.id === created.id)) {
      throw new Error("Created agent is missing from the agent list");
    }

    const feedResponse = await api(
      `/api/v1/streams/${created.id}/blocks`,
      {},
      token
    );
    const feed = await feedResponse.json();
    if (!Array.isArray(feed.entries)) {
      throw new Error("Stream feed did not return entries");
    }

    await api(
      `/api/v1/agents/${created.id}/stop`,
      { method: "POST", body: "{}" },
      token
    );
    console.log(`Smoke test passed for ${binaryPath}`);
  } finally {
    child.kill("SIGTERM");
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
