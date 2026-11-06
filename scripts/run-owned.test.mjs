import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  ownedEnvironment,
  killOwnedProcesses,
} from "../apps/server/src/shared/process/owned-processes.js";

const sleeper = "setInterval(() => {}, 1000)";
function alive(pid) {
  try {
    const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return !state.trim().startsWith("Z");
  } catch {
    return false;
  }
}
async function gone(pid) {
  for (let i = 0; i < 100 && alive(pid); i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive(pid), false, `owned PID ${pid} survived`);
}
for (const detached of [false, true]) {
  test(
    `cleanup after early leader exit (detached=${detached}) preserves control`,
    { skip: process.platform === "win32" },
    async () => {
      const control = spawn(process.execPath, ["-e", sleeper], {
        stdio: "ignore",
      });
      const owned = ownedEnvironment(process.env);
      let pid;
      try {
        const leader = spawn(
          process.execPath,
          [
            "-e",
            `
        const {spawn} = require('node:child_process');
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(sleeper)}], { detached: ${detached}, stdio: 'ignore' });
        console.log(child.pid); child.unref();
      `,
          ],
          { env: owned.env, stdio: ["ignore", "pipe", "ignore"] }
        );
        let out = "";
        leader.stdout.on("data", (b) => (out += b));
        await once(leader, "exit");
        pid = Number(out.trim());
        assert.ok(alive(pid));
        killOwnedProcesses(owned.marker);
        await gone(pid);
        assert.ok(alive(control.pid));
      } finally {
        killOwnedProcesses(owned.marker);
        control.kill("SIGKILL");
      }
    }
  );
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  test(
    `command boundary cleans up on ${signal}`,
    { skip: process.platform === "win32" },
    async () => {
      const wrapper = spawn(
        process.execPath,
        [
          "scripts/run-owned.mjs",
          process.execPath,
          "-e",
          `console.log(process.pid); ${sleeper}`,
        ],
        { stdio: ["ignore", "pipe", "ignore"] }
      );
      const exited = once(wrapper, "exit");
      const [out] = await once(wrapper.stdout, "data");
      const pid = Number(out.toString().trim());
      wrapper.kill(signal);
      await exited;
      await gone(pid);
    }
  );
}
