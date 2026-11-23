import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));

// Stand in for the supervisor so SIGKILL exercises the worker's kernel pipe
// lifeline without killing the test process or touching the machine's runner.
const supervisorScript = `
  const { spawn } = require("node:child_process");
  const { createWriteStream } = require("node:fs");
  const [bun, entry, cwd] = process.argv.slice(1);
  const worker = spawn(bun, ["--no-env-file", entry, "runner-terminal", cwd, "91", "37"], {
    stdio: ["pipe", "pipe", "inherit", "pipe"],
  });
  process.stdin.pipe(worker.stdin);
  worker.stdout.pipe(process.stdout);
  worker.stdio[3].pipe(createWriteStream(null, { fd: 3 }));
  worker.on("close", () => process.stdin.destroy());
`;

const isLive = (pid: number) => {
  try {
    const state = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return state !== "" && !state.startsWith("Z");
  } catch {
    return false;
  }
};

it
  .skipIf(process.getuid?.() === 0 || process.platform === "win32")
  .each(["channel EOF", "supervisor SIGKILL"])(
  "reaps the workload shell and its background job on %s",
  async (reason) => {
    const cwd = await mkdtemp(join(tmpdir(), "terminal-worker-"));
    const supervisor = spawn(
      process.execPath,
      ["-e", supervisorScript, process.env.BUN_BINARY ?? "bun", entry, cwd],
      {
        env: {
          PATH: process.env.PATH,
          HOME: cwd,
          USER: userInfo().username,
          SHELL: userInfo().shell ?? "/bin/sh",
        },
        stdio: ["pipe", "pipe", "inherit", "pipe"],
      }
    );
    const exited = once(supervisor, "close");
    const pids = new Set<number>();
    let lines = "";
    try {
      const ready = supervisor.stdio[3]!;
      const chunks: Buffer[] = [];
      for await (const chunk of ready) chunks.push(chunk);
      expect(JSON.parse(Buffer.concat(chunks).toString()).user).toBe(
        userInfo().username
      );
      let pending = "";
      supervisor.stdout!.on("data", (chunk: Buffer) => {
        pending += chunk.toString();
        const frames = pending.split("\n");
        pending = frames.pop()!;
        for (const frame of frames) {
          const event = JSON.parse(frame);
          if (event.type === "output")
            lines += Buffer.from(event.data, "base64").toString();
        }
        for (const match of lines.matchAll(/PTY_(?:SHELL|JOB)=(\d+)[\r\n]/g))
          pids.add(Number(match[1]));
      });
      supervisor.stdin!.write(
        JSON.stringify({
          type: "input",
          data: "sleep 300 &\necho PTY_SHELL=$$\necho PTY_JOB=$!\n",
        }) + "\n"
      );
      await expect.poll(() => pids.size).toBe(2);
      expect([...pids].every(isLive)).toBe(true);
      if (reason === "channel EOF") supervisor.stdin!.end();
      else supervisor.kill("SIGKILL");
      await exited;
      await expect.poll(() => [...pids].filter(isLive)).toEqual([]);
    } finally {
      supervisor.stdin!.destroy();
      supervisor.kill("SIGKILL");
      await exited;
      for (const pid of pids) {
        if (isLive(pid)) process.kill(pid, "SIGKILL");
      }
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15_000
);
