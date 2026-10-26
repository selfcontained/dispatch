import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Writes a tiny two-process fixture standing in for a real test launcher
 * (bun's own `vitest` CLI, or Playwright's) forking a worker. The launcher
 * has NO signal handler at all — it dies immediately on SIGTERM/SIGINT via
 * Node's default disposition, exactly like a real launcher reported to
 * exit on TERM while leaving its own forked worker running untouched.
 * A fix that only signals the launcher's own PID (not its full descendant
 * tree) fails to reach the worker here exactly as it does in production.
 */
export function writeProcessTreeFixture(opts: { stubbornWorker?: boolean }) {
  const dir = mkdtempSync("/tmp/dispatch-process-tree-fixture-");
  const markerFile = path.join(dir, "marker.log");
  const workerReadyFile = path.join(dir, "worker-ready");
  const launcherReadyFile = path.join(dir, "launcher-ready");

  const workerScript = path.join(dir, "worker.js");
  writeFileSync(
    workerScript,
    `
const fs = require("fs");
const markerFile = ${JSON.stringify(markerFile)};
const readyFile = ${JSON.stringify(workerReadyFile)};
const stubborn = ${opts.stubbornWorker ? "true" : "false"};
if (!stubborn) {
  process.on("SIGTERM", () => {
    fs.appendFileSync(markerFile, "worker-SIGTERM\\n");
    process.exit(0);
  });
  process.on("SIGINT", () => {
    fs.appendFileSync(markerFile, "worker-SIGINT\\n");
    process.exit(0);
  });
} else {
  // Explicitly ignores both — only SIGKILL can end it, exercising the
  // bounded TERM-then-escalate-to-KILL path.
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
}
fs.writeFileSync(readyFile, String(process.pid));
setInterval(() => {}, 1000);
`
  );

  const launcherScript = path.join(dir, "launcher.js");
  writeFileSync(
    launcherScript,
    `
const { spawn } = require("child_process");
const fs = require("fs");
const worker = spawn(process.execPath, [${JSON.stringify(workerScript)}], {
  stdio: "ignore",
});
fs.writeFileSync(${JSON.stringify(launcherReadyFile)}, String(worker.pid));
// Deliberately no signal handlers: see the module doc above.
setInterval(() => {}, 1000);
`
  );

  return {
    dir,
    launcherScript,
    markerFile,
    workerReadyFile,
    launcherReadyFile,
  };
}
