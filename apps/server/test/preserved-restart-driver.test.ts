import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

const driver = path.join(
  import.meta.dirname,
  "helpers/preserved-restart-driver.mjs"
);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function running(pid: number): boolean {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
    encoding: "utf8",
  });
  const state = result.stdout.trim();
  return state.length > 0 && !state.startsWith("Z");
}

async function ready(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await pause(25);
  }
  throw new Error(`Fixture did not become ready: ${file}`);
}

async function stopped(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!running(pid)) return;
    await pause(25);
  }
  throw new Error(`Fixture process still running: ${pid}`);
}

describe("preserved restart driver cancellation (subprocesses only)", () => {
  it.each<{
    name: string;
    signal?: "SIGTERM" | "SIGINT";
    stubborn?: boolean;
    commandExited?: boolean;
    success?: boolean;
  }>([
    { name: "TERM", signal: "SIGTERM" },
    { name: "INT", signal: "SIGINT" },
    { name: "stubborn descendant", signal: "SIGTERM", stubborn: true },
    { name: "launcher already exited", signal: "SIGTERM", commandExited: true },
    { name: "successful return keeps services", success: true },
  ])(
    "$name",
    async ({
      signal,
      stubborn = false,
      commandExited = false,
      success = false,
    }) => {
      const dir = mkdtempSync("/tmp/dispatch-restart-cancellation-");
      const workerReady = path.join(dir, "worker-ready");
      const launcherReady = path.join(dir, "launcher-ready");
      const events = path.join(dir, "events");
      const worker = path.join(dir, "worker.mjs");
      const bin = path.join(dir, "fake-restart.mjs");
      const journal = path.join(dir, "journal.jsonl");
      const identity = {
        agentId: "agt_fixture",
        journalId: "journal_fixture",
        startedSeq: 1,
        chatMessageId: "message_fixture",
        settled: false,
      };
      writeFileSync(
        journal,
        JSON.stringify({
          seq: 1,
          journalId: identity.journalId,
          event: {
            type: "turn",
            state: "started",
            agentId: identity.agentId,
            source: {
              chatMessageId: identity.chatMessageId,
              conversation: { streamId: identity.agentId },
            },
          },
        }) + "\n"
      );
      writeFileSync(
        worker,
        `
import { appendFileSync, writeFileSync } from "node:fs";
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  if (${stubborn} || stopping) return;
  stopping = true;
  // Make an early driver exit observable: parent cleanup must follow this.
  setTimeout(() => {
    appendFileSync(${JSON.stringify(events)}, "worker-stopped\\n");
    process.exit(0);
  }, 100);
});
writeFileSync(${JSON.stringify(workerReady)}, String(process.pid));
setInterval(() => {}, 1000);
`
      );
      writeFileSync(
        bin,
        `#!${process.execPath}
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
spawn(process.execPath, [${JSON.stringify(worker)}], { stdio: "ignore" });
writeFileSync(${JSON.stringify(launcherReady)}, String(process.pid));
// Default signal handling exits this launcher without forwarding to its child.
if (${commandExited || success}) {
  const ready = setInterval(() => {
    if (!existsSync(${JSON.stringify(workerReady)})) return;
    clearInterval(ready);
    ${success ? `appendFileSync(${JSON.stringify(journal)}, JSON.stringify({ seq: 2, journalId: "journal_fixture", event: { type: "turn", state: "settled", agentId: "agt_fixture" } }) + "\\n");` : ""}
    process.exit(0);
  }, 10);
} else setInterval(() => {}, 1000);
`,
        { mode: 0o755 }
      );
      const child = spawn(
        process.execPath,
        [
          driver,
          JSON.stringify({
            bin,
            cwd: dir,
            suffix: "fixture",
            journal,
            identity,
            hostPid: process.pid,
            deadline: Date.now() + 60_000,
          }),
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      const closed = once(child, "close");
      let output = "";
      child.stdout.on("data", (text) => {
        output += text;
      });
      child.stderr.on("data", (text) => {
        output += text;
      });
      let launcherPid = 0;
      let workerPid = 0;
      try {
        await ready(launcherReady);
        launcherPid = Number(readFileSync(launcherReady, "utf8"));
        await ready(workerReady);
        workerPid = Number(readFileSync(workerReady, "utf8"));
        expect(running(workerPid)).toBe(true);
        if (commandExited) await stopped(launcherPid);
        if (signal) child.kill(signal); // Same signal used by parent execFile's timeout.
        const [code] = await closed;
        appendFileSync(events, "parent-cleanup\n");
        expect(code, output).toBe(
          success ? 0 : signal === "SIGINT" ? 130 : 143
        );
        expect(running(launcherPid)).toBe(false);
        expect(running(workerPid)).toBe(success);
        if (!stubborn && !success)
          expect(readFileSync(events, "utf8")).toBe(
            "worker-stopped\nparent-cleanup\n"
          );
      } finally {
        // Only fixture-owned PIDs/groups. Never sweep shared processes.
        if (!launcherPid && existsSync(launcherReady))
          launcherPid = Number(readFileSync(launcherReady, "utf8"));
        if (launcherPid) {
          try {
            process.kill(-launcherPid, "SIGKILL");
          } catch {
            /* already stopped */
          }
        }
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await closed;
        if (workerPid) await stopped(workerPid);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
