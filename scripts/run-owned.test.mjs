import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  ownedEnvironment,
  killOwnedProcesses,
} from "../apps/server/src/shared/process/owned-processes.js";

// Fixtures self-expire even if test cancellation interrupts setup/finally.
const sleeper =
  "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 4000)";
function kill(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
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
    { skip: process.platform === "win32", timeout: 5000 },
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
        // Independent fixture cleanup must not depend on the helper under test.
        try {
          kill(pid);
        } finally {
          control.kill("SIGKILL");
        }
      }
    }
  );
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  test(
    `command boundary cleans up on ${signal}`,
    { skip: process.platform === "win32", timeout: 5000 },
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
      let pid;
      try {
        const exited = once(wrapper, "exit");
        const [out] = await once(wrapper.stdout, "data");
        pid = Number(out.toString().trim());
        wrapper.kill(signal);
        await exited;
        await gone(pid);
      } finally {
        try {
          kill(pid);
        } finally {
          wrapper.kill("SIGKILL");
        }
      }
    }
  );
}

test(
  "scan failure still terminates the known child and wrapper",
  { skip: process.platform === "win32", timeout: 5000 },
  async () => {
    const wrapper = spawn(
      process.execPath,
      [
        "scripts/run-owned.mjs",
        process.execPath,
        "-e",
        `console.log(process.pid); ${sleeper}`,
      ],
      {
        env: { ...process.env, PATH: "/nonexistent-owned-test" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let pid;
    try {
      const exited = once(wrapper, "exit");
      const [out] = await once(wrapper.stdout, "data");
      pid = Number(out.toString().trim());
      wrapper.kill("SIGTERM");
      const [code] = await exited;
      assert.equal(code, 1);
      await gone(pid);
    } finally {
      try {
        kill(pid);
      } finally {
        wrapper.kill("SIGKILL");
      }
    }
  }
);

test("enumeration failure preserves diagnostics without stdout or raw errors", async (t) => {
  if (process.platform === "win32") return t.skip();
  const { default: childProcess } = await import("node:child_process");
  const { syncBuiltinESMExports } = await import("node:module");
  const control = spawn(process.execPath, ["-e", sleeper], { stdio: "ignore" });
  try {
    t.mock.method(childProcess, "execFileSync", () => {
      throw Object.assign(new Error("SECRET stdout in original message"), {
        status: 2,
        stderr: Buffer.from("ps: unsupported option; TOKEN=secret"),
        stdout: Buffer.from("SECRET process environments"),
      });
    });
    syncBuiltinESMExports();
    assert.throws(
      () => killOwnedProcesses(ownedEnvironment({}).marker),
      (error) => {
        assert.match(error.message, /status=2/);
        assert.match(error.message, /ps: unsupported option/);
        assert.doesNotMatch(error.message, /SECRET|TOKEN=secret/);
        assert.equal(error.cause, undefined);
        return true;
      }
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    control.kill("SIGKILL");
  }
  await gone(control.pid);
});

test(
  "Linux argv marker does not claim an unrelated process",
  { skip: process.platform !== "linux", timeout: 5000 },
  async () => {
    const owned = ownedEnvironment(process.env);
    const control = spawn(process.execPath, ["-e", sleeper, owned.marker], {
      stdio: "ignore",
    });
    const child = spawn(process.execPath, ["-e", sleeper], {
      env: owned.env,
      stdio: "ignore",
    });
    try {
      killOwnedProcesses(owned.marker);
      await gone(child.pid);
      assert.ok(alive(control.pid));
    } finally {
      try {
        child.kill("SIGKILL");
      } finally {
        control.kill("SIGKILL");
      }
    }
  }
);
