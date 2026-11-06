// A per-command boundary for CI cancellation. Children retain the marker across
// setsid/reparenting; runner PGIDs and process names are never cleanup targets.
import { spawn } from "node:child_process";
import {
  ownedEnvironment,
  killOwnedProcesses,
} from "../apps/server/src/shared/process/owned-processes.js";
const [command, ...args] = process.argv.slice(2);
if (!command)
  throw new Error("Usage: node scripts/run-owned.mjs command [args...]");
const owned = ownedEnvironment(process.env);
const child = spawn(command, args, { env: owned.env, stdio: "inherit" });
let stopping = false;
function finish(code) {
  if (stopping) return;
  stopping = true;
  try {
    killOwnedProcesses(owned.marker);
  } catch {
    console.error("Owned process cleanup failed");
    code = 1;
  } finally {
    // The ChildProcess handle is owned even if enumeration is unavailable.
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
  process.exitCode = code;
}
child.on("error", () => finish(1));
child.on("exit", (code, signal) => finish(code ?? (signal ? 1 : 0)));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => finish(signal === "SIGINT" ? 130 : 143));
}
