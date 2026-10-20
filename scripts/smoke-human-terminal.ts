/** Run with Bun: real PTY smoke, never requests sudo or uses real credentials. */
import assert from "node:assert/strict";
import { spawnTerminal } from "../apps/server/src/terminal/manager.js";
let output = "";
const decoder = new TextDecoder();
const proc = spawnTerminal("/tmp", (data) => {
  output += decoder.decode(data, { stream: true });
});
async function waitFor(value: string) {
  const deadline = Date.now() + 5000;
  while (!output.includes(value)) {
    if (Date.now() > deadline)
      throw new Error(`PTY did not produce expected marker: ${value}`);
    await Bun.sleep(20);
  }
}
try {
  proc.terminal.resize(101, 37);
  proc.terminal.write(
    "stty size; stty -echo; printf 'PTY_%s\\n' READY; read smoke_value; stty echo; printf 'PTY_%s\\n' DONE\n"
  );
  await waitFor("PTY_READY");
  proc.terminal.write("fake-noecho-input-82731\n");
  await waitFor("PTY_DONE");
  assert(
    !output.includes("fake-noecho-input-82731"),
    "PTY echoed hidden input"
  );
  assert(output.includes("37 101"), "PTY resize did not reach child");
  proc.terminal.write("sleep 30\n");
  await Bun.sleep(100);
  proc.terminal.write("\x03");
  proc.terminal.write("printf 'PTY_%s\\n' INTERRUPTED\n");
  await waitFor("PTY_INTERRUPTED");
  proc.terminal.write("exit\n");
  assert.equal(
    await Promise.race([
      proc.exited,
      Bun.sleep(5000).then(() => {
        throw new Error("PTY shell did not exit");
      }),
    ]),
    0
  );
  console.log(
    "PASS: real Bun PTY interactive input, resize, no-echo, Ctrl-C and normal exit"
  );
} finally {
  try {
    proc.terminal.close();
  } catch {}
  try {
    proc.kill();
  } catch {}
}

// Explicit cleanup must reach an ordinary background job as well as its shell.
output = "";
const cleanup = spawnTerminal("/tmp", (data) => {
  output += decoder.decode(data, { stream: true });
});
try {
  cleanup.terminal.write("sleep 30 & printf 'CHILD_%s\\n' $!\n");
  const deadline = Date.now() + 5000;
  while (!/CHILD_(\d+)/.test(output)) {
    if (Date.now() > deadline) throw new Error("No background child marker");
    await Bun.sleep(20);
  }
  const childPid = Number(output.match(/CHILD_(\d+)/)![1]);
  cleanup.kill();
  await cleanup.exited;
  let alive = true;
  for (let attempt = 0; attempt < 100 && alive; attempt++) {
    try {
      process.kill(childPid, 0);
      await Bun.sleep(20);
    } catch {
      alive = false;
    }
  }
  assert(!alive, "Explicit cleanup left a background child alive");
  console.log("PASS: explicit cleanup terminates shell and background child");
} finally {
  cleanup.kill();
}

// Bash keeps ordinary background jobs alive when its interactive shell exits.
// Their PPID and controlling TTY are then lost; cleanup must retain session ownership.
const unrelated = Bun.spawn(["/bin/sleep", "30"]);
try {
  for (const mode of ["explicit", "shell-exit"] as const) {
    let bashOutput = "";
    const bashDecoder = new TextDecoder();
    const bash = spawnTerminal("/tmp", (data) => {
      bashOutput += bashDecoder.decode(data, { stream: true });
    });
    let childPid: number | undefined;
    try {
      bash.terminal.write("exec /bin/bash --noprofile --norc -i\n");
      bash.terminal.write("set +H; printf 'BASH_%s\\n' READY\n");
      const wait = async (pattern: RegExp) => {
        const until = Date.now() + 5000;
        while (!pattern.test(bashOutput)) {
          if (Date.now() > until)
            throw new Error("Bash smoke marker timed out");
          await Bun.sleep(10);
        }
      };
      await wait(/BASH_READY/);
      bash.terminal.write(
        `sleep 30 & printf 'CHILD_%s\\n' $!${mode === "shell-exit" ? "; exit" : ""}\n`
      );
      await wait(/CHILD_(\d+)/);
      childPid = Number(bashOutput.match(/CHILD_(\d+)/)![1]);
      if (mode === "shell-exit") await bash.exited;
      bash.kill();
      await bash.exited;
      let childAlive = true;
      for (let attempt = 0; attempt < 200 && childAlive; attempt++) {
        try {
          process.kill(childPid, 0);
          await Bun.sleep(10);
        } catch {
          childAlive = false;
        }
      }
      assert(!childAlive, `Bash ${mode} cleanup left background child alive`);
      process.kill(unrelated.pid, 0);
      console.log(
        `PASS: Bash ${mode} cleanup kills its background job and preserves unrelated process`
      );
    } finally {
      bash.kill();
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {}
      }
    }
  }
} finally {
  unrelated.kill();
  await unrelated.exited;
}
