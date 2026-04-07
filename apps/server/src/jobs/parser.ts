import { readFile } from "node:fs/promises";
import path from "node:path";

export type JobNotifyConfig = {
  onComplete: string[];
  onError: string[];
  onNeedsInput: string[];
};

export type JobDefinition = {
  name: string;
  schedule: string | null;
  timeoutMs: number;
  needsInputTimeoutMs: number;
  fullAccess: boolean;
  notify: JobNotifyConfig;
  body: string;
  filePath: string;
  directory: string;
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_NEEDS_INPUT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_PROMPT_BYTES = 100 * 1024; // 100 KB — avoids exceeding OS CLI arg limits

/** Build the expected file path for a job given its directory and file stem. */
export function jobFilePath(directory: string, name: string): string {
  const normalizedName = normalizeJobName(name);
  return path.join(path.resolve(directory), ".dispatch", "jobs", `${normalizedName}.md`);
}

export async function readJobDefinition(directory: string, name: string): Promise<JobDefinition> {
  const filePath = jobFilePath(directory, name);
  const normalizedDirectory = path.resolve(directory);
  const raw = await readFile(filePath, "utf8");
  return parseJobDefinition(raw, { directory: normalizedDirectory, filePath, fallbackName: normalizeJobName(name) });
}

export function parseJobDefinition(raw: string, opts: {
  directory: string;
  filePath: string;
  fallbackName?: string;
}): JobDefinition {
  const { frontmatter, body } = splitFrontmatter(raw);
  const parsed = parseSimpleYaml(frontmatter);
  const name = readString(parsed.name, "name") ?? opts.fallbackName;
  if (!name) throw new Error("Job frontmatter must include name.");
  const prompt = body.trim();
  if (!prompt) throw new Error("Job markdown body must include prompt instructions.");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error(`Job prompt exceeds maximum size of ${MAX_PROMPT_BYTES / 1024}KB.`);
  }

  const schedule = readString(parsed.schedule, "schedule");
  if (schedule && !isValidCronSchedule(schedule)) {
    throw new Error("schedule must be a 5-field cron expression.");
  }

  return {
    name,
    schedule,
    timeoutMs: parseDuration(readString(parsed.timeout, "timeout") ?? "30m", "timeout"),
    needsInputTimeoutMs: parseDuration(readString(parsed.needs_input_timeout, "needs_input_timeout") ?? "24h", "needs_input_timeout"),
    fullAccess: readBoolean(parsed.full_access, "full_access") ?? false,
    notify: parseNotifyConfig(parsed.notify),
    body: prompt,
    filePath: opts.filePath,
    directory: path.resolve(opts.directory)
  };
}

function normalizeJobName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new Error("Job name is required.");
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("..") || normalized === ".") {
    throw new Error("Job name must be a file stem, not a path.");
  }
  return normalized.endsWith(".md") ? normalized.slice(0, -3) : normalized;
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    throw new Error("Job file must start with YAML frontmatter delimited by ---.");
  }
  const newline = normalized.startsWith("---\r\n") ? "\r\n" : "\n";
  const close = normalized.indexOf(`${newline}---`, 3);
  if (close === -1) throw new Error("Job frontmatter is missing closing --- delimiter.");
  const afterClose = close + newline.length + 3;
  const bodyStart = normalized.slice(afterClose).startsWith("\r\n") ? afterClose + 2 : normalized.slice(afterClose).startsWith("\n") ? afterClose + 1 : afterClose;
  return {
    frontmatter: normalized.slice(3 + newline.length, close),
    body: normalized.slice(bodyStart)
  };
}

function parseSimpleYaml(input: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let currentMap: Record<string, unknown> | null = null;
  let currentListKey: string | null = null;
  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const line = stripComment(rawLine);
    if (!line.trim()) continue;

    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = line.trim();
    if (indent > 0 && trimmed.startsWith("- ")) {
      const list = currentMap && currentListKey ? currentMap[currentListKey] : null;
      if (!Array.isArray(list)) {
        throw new Error(`Unexpected frontmatter list item on line ${index + 1}: ${rawLine}`);
      }
      list.push(unwrapQuoted(trimmed.slice(2).trim()));
      continue;
    }

    const match = trimmed.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) throw new Error(`Invalid frontmatter line ${index + 1}: ${rawLine}`);

    const [, key, rawValue = ""] = match;
    if (indent === 0) {
      if (rawValue === "") {
        const nested: Record<string, unknown> = {};
        root[key] = nested;
        currentMap = nested;
      } else {
        root[key] = parseScalar(rawValue);
        currentMap = null;
      }
      currentListKey = null;
      continue;
    }

    if (!currentMap) throw new Error(`Unexpected nested frontmatter line ${index + 1}: ${rawLine}`);
    if (rawValue === "") {
      currentMap[key] = [];
      currentListKey = key;
    } else {
      currentMap[key] = parseScalar(rawValue);
      currentListKey = null;
    }
  }
  return root;
}

function stripComment(line: string): string {
  let quoted = false;
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if ((char === "'" || char === '"') && line[i - 1] !== "\\") {
      if (!quoted) {
        quoted = true;
        quote = char;
      } else if (quote === char) {
        quoted = false;
      }
    }
    if (!quoted && char === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const body = trimmed.slice(1, -1).trim();
    if (!body) return [];
    return body.split(",").map((part) => unwrapQuoted(part.trim())).filter(Boolean);
  }
  return unwrapQuoted(trimmed);
}

function unwrapQuoted(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function readString(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value.trim();
}

function readBoolean(value: unknown, name: string): boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function parseNotifyConfig(value: unknown): JobNotifyConfig {
  const notify = isRecord(value) ? value : {};
  return {
    onComplete: parseStringArray(notify.on_complete, "notify.on_complete"),
    onError: parseStringArray(notify.on_error, "notify.on_error"),
    onNeedsInput: parseStringArray(notify.on_needs_input, "notify.on_needs_input")
  };
}

function parseStringArray(value: unknown, name: string): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be a string array.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function parseDuration(value: string, name: string): number {
  const match = value.trim().match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) throw new Error(`${name} must be a duration like 30m, 24h, or 10s.`);
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`${name} must be a positive duration.`);
  const unit = match[2];
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * multipliers[unit];
}

function isValidCronSchedule(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field) => field.length > 0 && /^[A-Za-z0-9*/,\-]+$/.test(field));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
