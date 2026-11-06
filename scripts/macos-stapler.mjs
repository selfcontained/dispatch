import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

// Apple ticket lookups can lose their connection after notarization succeeds.
// Retry only that observed transport failure; never waive ticket validation.
export async function runStapler(
  action,
  app,
  {
    spawn = spawnSync,
    sleep = setTimeout,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {}
) {
  const delays = [5000, 10000, 20000];
  for (let attempt = 0; ; attempt++) {
    const result = spawn("xcrun", ["stapler", action, app], {
      encoding: "utf8",
    });
    if (result.stdout) stdout.write(result.stdout);
    if (result.stderr) stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status === 0) return;
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const transient =
      result.status === 68 &&
      /NSURLErrorDomain\s+Code=-1005\b/.test(output) &&
      /api\.apple-cloudkit\.com/.test(output);
    if (!transient || attempt === delays.length)
      throw new Error(`xcrun stapler ${action} failed (${result.status})`);
    stderr.write(
      `Apple ticket lookup lost its connection; retrying stapler ${action} in ${delays[attempt] / 1000}s\n`
    );
    await sleep(delays[attempt]);
  }
}
