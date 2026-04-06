#!/usr/bin/env node
type ParsedArgs = {
  command: "run";
  name: string;
  dir: string;
  noWait: boolean;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const response = await fetch(`${resolveServerUrl()}/api/v1/jobs/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeader(),
    },
    body: JSON.stringify({
      name: args.name,
      directory: args.dir,
      wait: !args.noWait,
    }),
  });

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
    const message = isRecord(body) && typeof body.error === "string" ? body.error : text || response.statusText;
    throw new Error(message);
  }

  console.log(JSON.stringify(body, null, 2));
}

function parseArgs(args: string[]): ParsedArgs {
  if (args[0] !== "jobs" || args[1] !== "run") {
    usage();
  }
  const name = args[2];
  if (!name || name.startsWith("-")) usage();
  let dir = process.cwd();
  let noWait = false;
  for (let i = 3; i < args.length; i++) {
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

function usage(): never {
  console.error("Usage: dispatch jobs run <name> --dir <directory> [--no-wait]");
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
