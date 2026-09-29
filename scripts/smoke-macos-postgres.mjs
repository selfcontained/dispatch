#!/usr/bin/env node
// Exercise the actual packaged runtime, relocated to a path containing spaces.
// No production database, service manager, TCP listener, or installed psql used.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { verifyPostgres, postgresSource } from "./download-macos-postgres.mjs";

const source = process.argv[2];
if (!source || process.platform !== "darwin")
  throw new Error(
    "Usage: node scripts/smoke-macos-postgres.mjs <Postgres directory> (macOS)"
  );
const temporary = mkdtempSync("/tmp/dispatch-pg-smoke-");
const sourcePath = path.resolve(source);
const enclosingApp = path.resolve(sourcePath, "../../..");
const isApp =
  enclosingApp.endsWith(".app") &&
  existsSync(path.join(enclosingApp, "Contents/Info.plist"));
const relocatedApp = path.join(
  temporary,
  "Relocated App",
  "Dispatch Preview.app"
);
const runtime = isApp
  ? path.join(relocatedApp, "Contents/Helpers/Postgres")
  : path.join(temporary, "Relocated App", "Postgres");
const data = path.join(temporary, "Database Data");
const socket = path.join(temporary, "socket");
let attemptedStart = false;
const env = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: temporary,
  LC_ALL: "C",
  LANG: "C",
};
function run(binary, args) {
  const result = spawnSync(path.join(runtime, "bin", binary), args, {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${binary} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}
try {
  cpSync(isApp ? enclosingApp : sourcePath, isApp ? relocatedApp : runtime, {
    recursive: true,
    verbatimSymlinks: true,
  });
  verifyPostgres(runtime, process.arch);
  mkdirSync(socket);
  run("initdb", [
    "-D",
    data,
    "-U",
    "dispatch_smoke",
    "--auth=trust",
    "--encoding=UTF8",
    "--locale=C",
  ]);
  attemptedStart = true;
  run("pg_ctl", [
    "-D",
    data,
    "-l",
    path.join(temporary, "postgres.log"),
    "-w",
    "-t",
    "30",
    "-o",
    `-h '' -k '${socket}'`,
    "start",
  ]);
  run("createdb", ["-h", socket, "-U", "dispatch_smoke", "dispatch_smoke"]);
  const result = run("psql", [
    "-X",
    "-A",
    "-t",
    "-h",
    socket,
    "-U",
    "dispatch_smoke",
    "-d",
    "dispatch_smoke",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "SELECT current_setting('server_version'), to_tsvector('english', 'relocatable databases');",
  ]);
  if (!result.startsWith(`${postgresSource.version}|`))
    throw new Error(`Unexpected smoke result: ${result}`);
  run("pg_ctl", ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"]);
  attemptedStart = false;
  console.log(`Relocated PostgreSQL smoke passed: ${result}`);
} finally {
  if (attemptedStart)
    run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "-t", "30", "stop"]);
  rmSync(temporary, { recursive: true, force: true });
}
