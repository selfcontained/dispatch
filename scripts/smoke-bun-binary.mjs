#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
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
const shellWrapperPath = path.join(tempRoot, "smoke-shell");
const port = Number(process.env.DISPATCH_SMOKE_PORT ?? 6878);
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://dispatch:dispatch@127.0.0.1:5432/postgres";
const marker = `BUN_SMOKE_${runId}`;

writeFileSync(
  shellWrapperPath,
  `#!/usr/bin/env bash
export TERM=xterm-256color
exec /bin/bash --noprofile --norc -i
`,
  "utf8"
);
chmodSync(shellWrapperPath, 0o755);

const child = spawn(binaryPath, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DISPATCH_HOST: "127.0.0.1",
    DISPATCH_PORT: String(port),
    DISPATCH_AGENT_RUNTIME: "tmux",
    MEDIA_ROOT: path.join(tempRoot, "media"),
    DISPATCH_RELEASE_STORE_PATH: path.join(tempRoot, "release.json"),
    SHELL: shellWrapperPath,
    TERM: "xterm-256color",
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

async function waitForTerminalReady(agentId, token) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const agentResponse = await api(`/api/v1/agents/${agentId}`, {}, token);
    const agentBody = await agentResponse.json();
    const status = agentBody.agent?.status;
    if (status === "error" || status === "stopped") {
      const detail = agentBody.agent?.lastError
        ? `: ${agentBody.agent.lastError}`
        : "";
      throw new Error(
        `Agent ${agentId} entered ${status} before terminal became ready${detail}`
      );
    }

    try {
      const terminalResponse = await api(
        `/api/v1/agents/${agentId}/terminal/token`,
        { method: "POST", body: "{}" },
        token
      );
      const terminalBody = await terminalResponse.json();
      if (terminalBody.mode === "tmux" && terminalBody.wsUrl) {
        return terminalBody;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("409") || error.message.includes("404"))
      ) {
        await Bun.sleep(250);
        continue;
      }
      throw error;
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for terminal access for agent ${agentId}`);
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
          type: "terminal",
          useWorktree: false,
        }),
      },
      token
    );
    const createBody = await createResponse.json();
    const agentId = createBody.agent.id;
    const terminalBody = await waitForTerminalReady(agentId, token);

    const ws = new WebSocket(
      `ws://127.0.0.1:${port}${terminalBody.wsUrl}&cols=120&rows=30`
    );
    const received = await new Promise((resolve, reject) => {
      const recentMessages = [];
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Timed out waiting for terminal echo. Recent messages: ${JSON.stringify(recentMessages)}`
            )
          ),
        15_000
      );
      ws.addEventListener("open", () => {
        setTimeout(() => {
          ws.send(
            JSON.stringify({ type: "input", data: `printf '${marker}\\n'\n` })
          );
        }, 1000);
      });
      ws.addEventListener("message", (event) => {
        const payload = JSON.parse(String(event.data));
        recentMessages.push(payload);
        if (recentMessages.length > 10) {
          recentMessages.shift();
        }
        if (
          payload.type === "output" &&
          String(payload.data).includes(marker)
        ) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error: ${event.type}`));
      });
    });

    if (!received) {
      throw new Error("Terminal round-trip failed");
    }

    ws.close();
    await api(
      `/api/v1/agents/${agentId}/stop`,
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
