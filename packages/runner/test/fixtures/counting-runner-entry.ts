/*
 * A runner binary for the reconnect test: the real local runner plus two
 * operations that record every request they receive in the state root.
 *   session.launch  (retry by key)   hangs on the first receipt of a
 *   checkout.exec   (retry none)     "hang-" key, answers later receipts.
 * `received.jsonl` has one line per receipt; `effects.jsonl` one line per key
 * the first time it completes (later receipts of a key return the first
 * result, as the contract requires of a keyed operation).
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLocalRunner } from "../../src/local/child.js";

const build = JSON.parse(
  process.env.RUNNER_TEST_BUILD ?? '{"version":"0.0.0-test"}'
) as { version: string; revision?: string };

await runLocalRunner(build, {
  handlers: (start) => {
    const root = start.roots.state;
    const record = <T>(key: string, result: T): Promise<T> | T => {
      appendFileSync(
        join(root, "received.jsonl"),
        JSON.stringify({ key, pid: process.pid }) + "\n"
      );
      const seen = join(root, `seen-${key}`);
      const done = join(root, `done-${key}`);
      if (existsSync(done)) return result;
      if (key.startsWith("hang-") && !existsSync(seen)) {
        writeFileSync(seen, "");
        return new Promise<T>(() => {}); // Never answers: killed mid-call.
      }
      writeFileSync(done, "");
      appendFileSync(
        join(root, "effects.jsonl"),
        JSON.stringify({ key }) + "\n"
      );
      return result;
    };
    return {
      calls: {
        "session.launch": (input) => record(input.launchId, {}),
        "checkout.exec": (input) =>
          record(input.argv[0] ?? "", { exitCode: 0, stdout: "", stderr: "" }),
      },
    };
  },
});
