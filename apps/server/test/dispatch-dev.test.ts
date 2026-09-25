import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const BIN = path.join(REPO_ROOT, "bin", "dispatch-dev");
const SUFFIX = `test-${process.pid}-${Date.now()}`;
const STATE_FILE = `/tmp/dispatch-dev-${SUFFIX}.env`;
const LOG_DIR = `/tmp/dispatch-dev-${SUFFIX}`;
const HOST_WRAPPER = `/tmp/dispatch-dev-host-${SUFFIX}.sh`;

function stateValue(name: string): string {
  const line = readFileSync(STATE_FILE, "utf8")
    .split("\n")
    .find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} missing from ${STATE_FILE}`);
  return line.slice(name.length + 1);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition did not become true within 20s");
}

function run(
  args: string,
  options?: { expectFail?: boolean; env?: Record<string, string> }
): string {
  try {
    return execSync(`${BIN} ${args}${args ? " " : ""}--suffix ${SUFFIX}`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...options?.env,
        // Clear agent ID so it doesn't leak into suffix
        DISPATCH_AGENT_ID: "",
      },
    }).trim();
  } catch (error) {
    if (options?.expectFail) {
      const err = error as { stderr?: string; stdout?: string };
      // Combine stdout + stderr since the script writes to both
      return `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
    }
    throw error;
  }
}

describe("dispatch-dev", () => {
  afterAll(() => {
    // Ensure cleanup even if tests fail
    try {
      run("down");
    } catch {
      // already down
    }
  });

  it("shows usage when no command is given", () => {
    const output = run("", { expectFail: true });
    expect(output).toContain("Usage: dispatch-dev");
  });

  it("reports nothing when status called with no stack", () => {
    const output = run("status");
    expect(output).toContain("No dev environment found");
  });

  it("starts and stops a full stack", () => {
    // --- up ---
    const upOutput = run("up", { env: { DISPATCH_HOST: "127.0.0.1" } });
    expect(upOutput).toContain("Database ready on port");
    expect(upOutput).toContain("API server starting on port");
    expect(upOutput).toContain("Vite dev server starting on port");
    expect(upOutput).toContain("Dev environment ready");

    // State file written
    expect(existsSync(STATE_FILE)).toBe(true);
    const state = readFileSync(STATE_FILE, "utf8");
    expect(state).toContain(`DEV_SUFFIX=${SUFFIX}`);
    expect(state).toMatch(/DEV_API_PORT=\d+/);
    expect(state).toMatch(/DEV_API_PID=\d+/);
    expect(state).toMatch(/DEV_DB_PORT=\d+/);
    expect(state).toContain(
      `DEV_RELEASE_CACHE_DIR=${REPO_ROOT}/.dispatch/dev-cache/release-${SUFFIX}`
    );

    // --- status ---
    const statusOutput = run("status");
    expect(statusOutput).toContain("db:   running");
    expect(statusOutput).toContain("api:  running");
    expect(statusOutput).toContain("vite:");
    expect(statusOutput).toContain("release cache:");

    // --- url ---
    const urlOutput = run("url");
    expect(urlOutput).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // --- logs ---
    const logsOutput = run("logs");
    expect(logsOutput.length).toBeGreaterThan(0);

    // --- down ---
    // Stopping a stack keeps its database: pulling a change that needs a
    // restart should not cost the agents on it.
    const downOutput = run("down");
    expect(downOutput).toContain("Stopped API server");
    expect(downOutput).toContain("Stopped database container (data kept");
    expect(downOutput).toContain("Dev environment torn down");
    expect(existsSync(STATE_FILE)).toBe(false);
    expect(existsSync(LOG_DIR)).toBe(true);

    // --- down --wipe ---
    // Starting over is the explicit ask, and takes the data and the logs.
    const wipeOutput = run("up") && run("down --wipe");
    expect(wipeOutput).toContain("Removed database container and its data");
    expect(existsSync(STATE_FILE)).toBe(false);
    expect(existsSync(LOG_DIR)).toBe(false);
  }, 120_000);

  it("reports a custom DISPATCH_HOST in status and url output", () => {
    // The stack binds to DISPATCH_HOST, but 0.0.0.0 is not a host a browser
    // can open, so status and url print the loopback address for it.
    const displayHost = "127.0.0.1";

    try {
      const upOutput = run("up --no-db", {
        env: { DISPATCH_HOST: "0.0.0.0" },
      });
      expect(upOutput).toContain(`api: http://${displayHost}:`);
      expect(upOutput).toContain(`web: http://${displayHost}:`);

      const statusOutput = run("status");
      expect(statusOutput).toContain(`api:  running — http://${displayHost}:`);
      expect(statusOutput).toContain(`vite: running — http://${displayHost}:`);

      const urlOutput = run("url");
      expect(urlOutput).toMatch(
        new RegExp(`^http://${displayHost.replaceAll(".", "\\.")}:\\d+$`)
      );
    } finally {
      run("down");
    }
  }, 60_000);

  it("refuses to start a second stack with the same suffix", () => {
    try {
      run("up");
      const output = run("up", { expectFail: true });
      expect(output).toContain("already running");
    } finally {
      run("down");
    }
  }, 60_000);

  it.each([
    { preserveHosts: false, upArgs: "up --live" },
    {
      preserveHosts: true,
      upArgs: "up --live --preserve-agent-hosts",
    },
  ])(
    "$upArgs handles an in-flight detached agent host across restart",
    async ({ preserveHosts, upArgs }) => {
      const fakeAgent = path.join(
        REPO_ROOT,
        "e2e",
        "fixtures",
        "fake-acp-agent.mjs"
      );
      const mainTs = path.join(REPO_ROOT, "apps", "server", "src", "main.ts");
      writeFileSync(
        HOST_WRAPPER,
        [
          "#!/usr/bin/env bash",
          `export DISPATCH_ACP_ADAPTER_COMMAND='${JSON.stringify([fakeAgent])}'`,
          `exec bun ${JSON.stringify(mainTs)} agent-host "$@"`,
          "",
        ].join("\n")
      );
      chmodSync(HOST_WRAPPER, 0o700);

      let hostPid = 0;
      try {
        run(upArgs, {
          env: {
            DISPATCH_AGENT_HOST_COMMAND: JSON.stringify([HOST_WRAPPER]),
            DISPATCH_HOST: "127.0.0.1",
          },
        });
        const port = Number(stateValue("DEV_API_PORT"));
        const api = `http://127.0.0.1:${port}/api/v1`;
        const created = await fetch(`${api}/agents`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "dispatch-dev-restart-host",
            type: "claude",
            cwd: "/tmp",
            useWorktree: false,
          }),
        });
        expect(created.status).toBe(201);
        const agentId = ((await created.json()) as { agent: { id: string } })
          .agent.id;
        await until(async () => {
          const response = await fetch(`${api}/agents/${agentId}`);
          const body = (await response.json()) as { agent: { status: string } };
          return body.agent.status === "running";
        });

        const agentDir = path.join(LOG_DIR, "agents", agentId);
        hostPid = Number(readFileSync(path.join(agentDir, "host.pid"), "utf8"));
        expect(processAlive(hostPid)).toBe(true);

        const prompted = await fetch(`${api}/streams/${agentId}/blocks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "sleep:10000" }),
        });
        expect(prompted.ok).toBe(true);
        const journal = path.join(agentDir, "journal.jsonl");
        await until(() =>
          readFileSync(journal, "utf8").includes('"state":"started"')
        );

        expect(stateValue("DEV_PRESERVE_AGENT_HOSTS")).toBe(
          preserveHosts ? "1" : "0"
        );
        const restart = run("restart");
        expect(restart).toContain("Stopped API server");
        expect(restart).toContain("Dev environment ready");
        expect(stateValue("DEV_PRESERVE_AGENT_HOSTS")).toBe(
          preserveHosts ? "1" : "0"
        );

        if (preserveHosts) {
          expect(
            Number(readFileSync(path.join(agentDir, "host.pid"), "utf8"))
          ).toBe(hostPid);
          expect(processAlive(hostPid)).toBe(true);

          await until(() => {
            const events = readFileSync(journal, "utf8")
              .trim()
              .split("\n")
              .map(
                (line) =>
                  JSON.parse(line) as { event?: Record<string, unknown> }
              );
            return events.some(
              ({ event }) =>
                event?.type === "turn" &&
                event.state === "settled" &&
                event.error === undefined
            );
          });
          let turn:
            | {
                settled: boolean;
                error?: string;
                result?: { text: string } | null;
              }
            | undefined;
          await until(async () => {
            const feed = (await (
              await fetch(`${api}/streams/${agentId}/blocks`)
            ).json()) as {
              entries: Array<{ block?: { turn?: typeof turn } }>;
            };
            turn = feed.entries.find((entry) => entry.block?.turn)?.block?.turn;
            return (
              turn?.settled === true &&
              turn.error === undefined &&
              turn.result?.text.includes("sleep:10000") === true
            );
          });
          expect(turn?.settled).toBe(true);
          expect(turn?.error).toBeUndefined();
          expect(turn?.result?.text).toContain("sleep:10000");

          // A missing DB container used to send this path through cmd_down,
          // which killed a still-working host despite the preserve opt-in.
          const secondPrompt = await fetch(`${api}/streams/${agentId}/blocks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "sleep:15000" }),
          });
          expect(secondPrompt.ok).toBe(true);
          await until(() =>
            readFileSync(journal, "utf8").includes("sleep:15000")
          );
          execSync(`docker stop dispatch-postgres-${SUFFIX}`, {
            encoding: "utf8",
            timeout: 20_000,
          });
          const recovered = run("restart");
          expect(recovered).toContain(
            "recreating it without stopping agent hosts"
          );
          expect(stateValue("DEV_PRESERVE_AGENT_HOSTS")).toBe("1");
          expect(
            Number(readFileSync(path.join(agentDir, "host.pid"), "utf8"))
          ).toBe(hostPid);
          expect(processAlive(hostPid)).toBe(true);
          await until(async () => {
            try {
              const response = await fetch(`${api}/streams/${agentId}/blocks`);
              if (!response.ok) return false;
              const feed = (await response.json()) as {
                entries: Array<{ block?: { turn?: typeof turn } }>;
              };
              return feed.entries.some(
                (entry) =>
                  entry.block?.turn?.settled === true &&
                  entry.block.turn.error === undefined &&
                  entry.block.turn.result?.text.includes("sleep:15000") === true
              );
            } catch {
              // The API socket may reset while the restarted server takes
              // ownership of the preserved host's journal.
              return false;
            }
          });
        } else {
          await until(() => !processAlive(hostPid));
        }

        run("down");
        if (preserveHosts) {
          await until(() => !processAlive(hostPid));
        }
      } finally {
        try {
          run("down");
        } catch {
          // already down
        }
        rmSync(HOST_WRAPPER, { force: true });
      }
    },
    120_000
  );

  it("cleans stale state on up", () => {
    // Create a fake state file with a dead PID
    const fakeState = [
      `DEV_SUFFIX=${SUFFIX}`,
      "DEV_CWD=/tmp",
      "DEV_DB_PORT=1",
      "DEV_API_PORT=1",
      "DEV_API_PID=99999",
      "DEV_CONTAINER_SUFFIX=",
      "DEV_COMPOSE_PROJECT=",
      "DEV_NO_DB=1",
    ].join("\n");
    require("node:fs").writeFileSync(STATE_FILE, fakeState);

    try {
      const output = run("up --no-db");
      expect(output).toContain("Cleaning stale state");
      expect(output).toContain("API server starting on port");
    } finally {
      run("down");
    }
  }, 60_000);
});
