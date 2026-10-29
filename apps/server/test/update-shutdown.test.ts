import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getTestDatabaseUrl, setupTestDb, teardownTestDb } from "./db/setup.js";

beforeAll(async () => {
  await setupTestDb();
});
afterAll(teardownTestDb);

it("exits cleanly on SIGTERM while a browser event stream is connected", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "dispatch-shutdown-test-"));
  const env = { ...process.env };
  for (const key of [
    "TLS_CERT",
    "TLS_KEY",
    "DISPATCH_LOCAL_TLS",
    "DISPATCH_LISTEN_HOSTS",
    "DISPATCH_UPDATE_OWNER",
    "SKIP_MIGRATIONS",
  ])
    delete env[key];
  const child = spawn("bun", ["src/main.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...env,
      DATABASE_URL: getTestDatabaseUrl(),
      DISPATCH_PORT: "0",
      DISPATCH_HOST: "127.0.0.1",
      DISPATCH_AGENT_RUNTIME: "inert",
      DISPATCH_STATE_DIR: state,
      DISPATCH_FILES_ROOT: path.join(state, "files"),
      DISPATCH_AGENT_STATE_ROOT: path.join(state, "agents"),
      DISPATCH_RELEASE_STORE_PATH: path.join(state, "release.json"),
      DISPATCH_RELEASE_CANDIDATE_STORE_PATH: path.join(state, "candidate.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  const controller = new AbortController();
  let output = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Startup timed out: ${output}`)),
        15_000
      );
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`Server exited: ${output}`)));
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        const address = output.match(
          /Server listening at (http:\/\/127\.0\.0\.1:\d+)/
        )?.[1];
        if (address) {
          clearTimeout(timer);
          resolve(address);
        }
      });
    });
    const response = await fetch(`${origin}/api/v1/events`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const snapshot = await response.body!.getReader().read();
    expect(new TextDecoder().decode(snapshot.value)).toContain(
      '"type":"snapshot"'
    );
    child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Shutdown timed out: ${output}`)),
          5_000
        );
      }),
    ]);
    expect(result).toEqual([0, null]);
    expect(output).toContain('"stage":"http","msg":"Shutdown stage completed"');
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
    await rm(state, { recursive: true, force: true });
  }
});
