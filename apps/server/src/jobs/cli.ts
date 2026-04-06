#!/usr/bin/env node
type ParsedArgs =
  | { command: "run"; name: string; dir: string; noWait: boolean }
  | { command: "enable"; name: string; dir: string }
  | { command: "disable"; name: string; dir: string }
  | { command: "list" }
  | { command: "history"; name: string; dir: string; limit: number };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "run":
      return await runCommand(args);
    case "enable":
      return await enableCommand(args);
    case "disable":
      return await disableCommand(args);
    case "list":
      return await listCommand();
    case "history":
      return await historyCommand(args);
  }
}

async function runCommand(args: { name: string; dir: string; noWait: boolean }): Promise<void> {
  const body = await postJson("/api/v1/jobs/run", {
    name: args.name,
    directory: args.dir,
    wait: !args.noWait,
  });
  console.log(JSON.stringify(body, null, 2));
}

async function enableCommand(args: { name: string; dir: string }): Promise<void> {
  const body = await postJson("/api/v1/jobs/enable", {
    name: args.name,
    directory: args.dir,
  });
  if (isRecord(body)) {
    console.log(`Job "${body.name}" enabled in ${body.directory}`);
  }
}

async function disableCommand(args: { name: string; dir: string }): Promise<void> {
  const body = await postJson("/api/v1/jobs/disable", {
    name: args.name,
    directory: args.dir,
  });
  if (isRecord(body)) {
    console.log(`Job "${body.name}" disabled in ${body.directory}`);
  }
}

async function listCommand(): Promise<void> {
  const url = `${resolveServerUrl()}/api/v1/jobs`;
  const response = await fetch(url, {
    headers: { ...authHeader() },
  });
  const body = await parseResponse(response);
  if (!Array.isArray(body)) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (body.length === 0) {
    console.log("No jobs found. Run or enable a job first.");
    return;
  }

  for (const job of body) {
    const status = job.enabled ? "enabled" : "disabled";
    const lastRun = job.lastRunStatus
      ? `last: ${job.lastRunStatus} (${formatTimeAgo(job.lastRunStartedAt)})`
      : "never run";
    console.log(`  ${job.name}  [${status}]  ${job.directory}`);
    console.log(`    ${lastRun}`);
  }
}

async function historyCommand(args: { name: string; dir: string; limit: number }): Promise<void> {
  const params = new URLSearchParams({
    name: args.name,
    directory: args.dir,
    limit: String(args.limit),
  });
  const url = `${resolveServerUrl()}/api/v1/jobs/history?${params}`;
  const response = await fetch(url, {
    headers: { ...authHeader() },
  });
  const body = await parseResponse(response);
  if (!isRecord(body) || !Array.isArray(body.runs)) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const job = body.job as Record<string, unknown>;
  console.log(`Job: ${job.name} (${job.directory})`);
  console.log();

  const runs = body.runs as Array<Record<string, unknown>>;
  if (runs.length === 0) {
    console.log("  No runs found.");
    return;
  }

  for (const run of runs) {
    const duration = typeof run.durationMs === "number" ? formatDuration(run.durationMs) : "-";
    const summary = isRecord(run.report) && typeof run.report.summary === "string"
      ? run.report.summary
      : "";
    console.log(`  ${run.status}  ${formatTimeAgo(run.startedAt as string)}  (${duration})`);
    if (summary) console.log(`    ${summary}`);
  }
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): ParsedArgs {
  if (args[0] !== "jobs") usage();
  const subcommand = args[1];

  switch (subcommand) {
    case "run":
      return parseNameDirArgs(args.slice(2), "run");
    case "enable":
      return { ...parseNameDirOnlyArgs(args.slice(2), "enable"), command: "enable" };
    case "disable":
      return { ...parseNameDirOnlyArgs(args.slice(2), "disable"), command: "disable" };
    case "list":
      return { command: "list" };
    case "history":
      return parseHistoryArgs(args.slice(2));
    default:
      usage();
  }
}

function parseNameDirArgs(
  args: string[],
  _command: "run"
): ParsedArgs & { command: "run" } {
  const name = args[0];
  if (!name || name.startsWith("-")) usage();
  let dir = process.cwd();
  let noWait = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dir") {
      const value = args[++i];
      if (!value) usage();
      dir = value;
      continue;
    }
    if (arg === "--no-wait") {
      noWait = true;
      continue;
    }
    usage();
  }
  return { command: "run", name, dir, noWait };
}

function parseNameDirOnlyArgs(
  args: string[],
  command: string
): { name: string; dir: string } {
  const name = args[0];
  if (!name || name.startsWith("-")) {
    console.error(`Usage: dispatch jobs ${command} <name> [--dir <directory>]`);
    process.exit(1);
  }
  let dir = process.cwd();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dir") {
      const value = args[++i];
      if (!value) {
        console.error(`Usage: dispatch jobs ${command} <name> [--dir <directory>]`);
        process.exit(1);
      }
      dir = value;
      continue;
    }
    console.error(`Usage: dispatch jobs ${command} <name> [--dir <directory>]`);
    process.exit(1);
  }
  return { name, dir };
}

function parseHistoryArgs(args: string[]): ParsedArgs & { command: "history" } {
  const name = args[0];
  if (!name || name.startsWith("-")) {
    console.error("Usage: dispatch jobs history <name> [--dir <directory>] [--limit <n>]");
    process.exit(1);
  }
  let dir = process.cwd();
  let limit = 20;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dir") {
      const value = args[++i];
      if (!value) {
        console.error("Usage: dispatch jobs history <name> [--dir <directory>] [--limit <n>]");
        process.exit(1);
      }
      dir = value;
      continue;
    }
    if (arg === "--limit") {
      const value = args[++i];
      if (!value) {
        console.error("Usage: dispatch jobs history <name> [--dir <directory>] [--limit <n>]");
        process.exit(1);
      }
      limit = Number(value);
      if (!Number.isFinite(limit) || limit < 1) {
        console.error("--limit must be a positive integer");
        process.exit(1);
      }
      continue;
    }
    console.error("Usage: dispatch jobs history <name> [--dir <directory>] [--limit <n>]");
    process.exit(1);
  }
  return { command: "history", name, dir, limit };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function postJson(path: string, data: unknown): Promise<unknown> {
  const response = await fetch(`${resolveServerUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeader(),
    },
    body: JSON.stringify(data),
  });
  return parseResponse(response);
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.error === "string" ? body.error : text || response.statusText;
    throw new Error(message);
  }
  return body;
}

function resolveServerUrl(): string {
  const explicit = process.env.DISPATCH_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const host = process.env.DISPATCH_HOST?.trim() || "127.0.0.1";
  const port = process.env.DISPATCH_PORT?.trim() || "6767";
  const scheme = process.env.DISPATCH_SCHEME?.trim() || "http";
  return `${scheme}://${host}:${port}`;
}

function authHeader(): Record<string, string> {
  const token = process.env.DISPATCH_AUTH_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatTimeAgo(dateStr: unknown): string {
  if (typeof dateStr !== "string") return "unknown";
  const ms = Date.now() - new Date(dateStr).getTime();
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function usage(): never {
  console.error(`Usage: dispatch jobs <command> [options]

Commands:
  run <name> [--dir <dir>] [--no-wait]    Run a job
  enable <name> [--dir <dir>]             Enable scheduling for a job
  disable <name> [--dir <dir>]            Disable scheduling for a job
  list                                    List all known jobs
  history <name> [--dir <dir>] [--limit]  Show run history for a job`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
