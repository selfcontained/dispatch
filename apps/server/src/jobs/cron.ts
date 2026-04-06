import { execFile } from "node:child_process";

import { Cron } from "croner";

const CRON_MARKER = "# dispatch-job";

/**
 * Build the marker comment that tags a crontab entry as Dispatch-owned.
 * Format: `# dispatch-job:<directory>:<name>`
 */
function marker(directory: string, name: string): string {
  return `${CRON_MARKER}:${directory}:${name}`;
}

/** Read the current user crontab lines. Returns [] if no crontab exists. */
async function readCrontab(): Promise<string[]> {
  const stdout = await exec("crontab", ["-l"]).catch((err) => {
    // "no crontab for <user>" is not an error for our purposes
    if (typeof err?.stderr === "string" && /no crontab/i.test(err.stderr)) return "";
    throw err;
  });
  return stdout.split("\n");
}

/** Write lines back to the user crontab. */
async function writeCrontab(lines: string[]): Promise<void> {
  const content = lines.join("\n");
  await new Promise<void>((resolve, reject) => {
    const proc = execFile("crontab", ["-"], (err) => (err ? reject(err) : resolve()));
    proc.stdin?.end(content);
  });
}

/**
 * Install a cron entry for a Dispatch job.
 * Removes any existing entry for the same job first.
 */
export async function installCronEntry(opts: {
  directory: string;
  name: string;
  schedule: string;
  dispatchBin: string;
  authToken?: string;
  serverUrl?: string;
}): Promise<void> {
  const lines = await readCrontab();
  const tag = marker(opts.directory, opts.name);

  // Remove existing entries for this job
  const filtered = removeTaggedLines(lines, tag);

  // Build env vars for the cron command
  const envParts: string[] = [];
  if (opts.authToken) envParts.push(`DISPATCH_AUTH_TOKEN=${shellEscape(opts.authToken)}`);
  if (opts.serverUrl) envParts.push(`DISPATCH_URL=${shellEscape(opts.serverUrl)}`);

  const envPrefix = envParts.length > 0 ? envParts.join(" ") + " " : "";
  const command = `${envPrefix}${opts.dispatchBin} jobs run ${shellEscape(opts.name)} --dir ${shellEscape(opts.directory)} --no-wait`;
  const entry = `${opts.schedule} ${command}`;

  // Add marker + entry
  filtered.push(tag);
  filtered.push(entry);

  // Ensure trailing newline
  if (filtered[filtered.length - 1] !== "") {
    filtered.push("");
  }

  await writeCrontab(filtered);
}

/** Remove the cron entry for a Dispatch job. */
export async function removeCronEntry(directory: string, name: string): Promise<void> {
  const lines = await readCrontab();
  const tag = marker(directory, name);
  const filtered = removeTaggedLines(lines, tag);

  // Ensure trailing newline
  if (filtered.length > 0 && filtered[filtered.length - 1] !== "") {
    filtered.push("");
  }

  await writeCrontab(filtered);
}

/** List all Dispatch-managed cron entries. */
export async function listCronEntries(): Promise<Array<{ directory: string; name: string; schedule: string }>> {
  const lines = await readCrontab();
  const entries: Array<{ directory: string; name: string; schedule: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith(CRON_MARKER + ":")) continue;

    // Parse marker: # dispatch-job:<directory>:<name>
    const rest = line.slice(CRON_MARKER.length + 1);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon <= 0) continue;

    const directory = rest.slice(0, lastColon);
    const name = rest.slice(lastColon + 1);

    // Next line should be the cron entry
    const cronLine = lines[i + 1];
    if (!cronLine || cronLine.startsWith("#")) continue;

    // Extract the 5-field schedule from the cron line
    const fields = cronLine.trim().split(/\s+/);
    if (fields.length >= 5) {
      entries.push({ directory, name, schedule: fields.slice(0, 5).join(" ") });
    }
  }

  return entries;
}

/**
 * Get the next scheduled run time for a cron expression.
 * Returns null if the expression is invalid.
 */
export function getNextRun(schedule: string): Date | null {
  try {
    const job = new Cron(schedule);
    const next = job.nextRun();
    return next;
  } catch {
    return null;
  }
}

/**
 * Format a cron expression as a human-readable string.
 */
export function describeCronSchedule(schedule: string): string {
  try {
    const job = new Cron(schedule);
    const next = job.nextRun();
    if (!next) return schedule;
    // Return the raw cron + next run for now; a full human-readable
    // description can be added later if needed.
    return schedule;
  } catch {
    return schedule;
  }
}

/** Remove lines associated with a specific tag (the tag line + the cron line after it). */
function removeTaggedLines(lines: string[], tag: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === tag) {
      // Skip the tag and the following cron line
      i++;
      continue;
    }
    result.push(lines[i]);
  }
  return result;
}

function shellEscape(value: string): string {
  // If the value is safe, return as-is
  if (/^[A-Za-z0-9_./:=-]+$/.test(value)) return value;
  // Otherwise single-quote it, escaping embedded single quotes
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) {
        const e = err as Error & { stderr?: string };
        e.stderr = stderr;
        reject(e);
        return;
      }
      resolve(stdout);
    });
  });
}
