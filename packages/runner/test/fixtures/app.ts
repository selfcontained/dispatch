/*
 * A parent app for process tests: supervises one local runner and prints
 * each state as a JSON line. Configured by environment:
 *   STATE_ROOT, APP_BUILD (JSON), RUNNER_TEST_BUILD (JSON, the runner's),
 *   BACKOFF_MS (initial backoff).
 */
import { fileURLToPath } from "node:url";
import { superviseRunner } from "@dispatch/runner-client/launcher";

const entry = fileURLToPath(
  new URL(process.env.RUNNER_ENTRY ?? "./runner-entry.ts", import.meta.url)
);
const build = JSON.parse(process.env.APP_BUILD ?? '{"version":"0.0.0-test"}');
const print = (value: object) =>
  process.stdout.write(JSON.stringify({ app: process.pid, ...value }) + "\n");

const supervisor = superviseRunner({
  command: [process.execPath, entry, "local-runner"],
  env: {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    HOME: process.env.HOME,
    RUNNER_TEST_BUILD: process.env.RUNNER_TEST_BUILD ?? JSON.stringify(build),
  },
  start: {
    build,
    roots: { state: process.env.STATE_ROOT!, files: process.env.STATE_ROOT! },
    config: { runnerId: "local", displayName: "Local", engines: [] },
  },
  backoff: {
    initialMs: Number(process.env.BACKOFF_MS ?? 100),
    maxMs: 2_000,
  },
  onState(state) {
    if (state.state === "ready")
      print({
        event: "ready",
        pid: state.runner.pid,
        socket: state.runner.ready.socket,
        nonce: state.runner.ready.nonce,
      });
    else if (state.state === "waiting")
      print({
        event: "waiting",
        reason: (state.error as { reason?: string }).reason ?? null,
        message: state.error.message,
        retryInMs: state.retryInMs,
        at: Date.now(),
      });
    else print({ event: state.state, at: Date.now() });
  },
});

process.on("SIGTERM", () => {
  void supervisor.stop(2_000).then(() => process.exit(0));
});
