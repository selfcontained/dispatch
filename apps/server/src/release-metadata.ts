import { z } from "zod";

import { compareSemver } from "./server/release-helpers.js";

export const ASSISTED_UPDATE_MODES = [
  "normal",
  "recommended",
  "required",
] as const;
export type AssistedUpdateMode = (typeof ASSISTED_UPDATE_MODES)[number];

export const REQUIRED_CHECK_NAMES = [
  "expected_runtime_artifact",
  "service_entrypoint",
  "service_restarted",
  "health_endpoint",
  "version_converged",
  // Proves the actual running executable's baked-in version (via the
  // X-Dispatch-Version response header), not what release.json claims.
  // Runtimes before v0.33 reject unknown check names when parsing update
  // migration manifests, so keep this OUT of update-migrations/*.yaml
  // requiredChecks until the pre-v0.33 population is gone — the assisted
  // framework enforces it implicitly (see runAndRecordChecks).
  "running_version",
] as const;
export type RequiredCheckName = (typeof REQUIRED_CHECK_NAMES)[number];

const semverPattern = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const RequiredCheckSchema = z.union([
  z.enum(REQUIRED_CHECK_NAMES),
  z.object({
    name: z.enum(REQUIRED_CHECK_NAMES),
    description: z.string().optional(),
  }),
]);

export const AssistedUpdateMetadataSchema = z.object({
  mode: z.enum(ASSISTED_UPDATE_MODES).default("normal"),
  title: z.string().min(1),
  summary: z.string().min(1),
  instructions: z.string().optional(),
  requiredChecks: z.array(RequiredCheckSchema).default([]),
  rollbackGuidance: z.string().optional(),
  appliesFrom: z
    .string()
    .regex(semverPattern, "appliesFrom must be a semver tag (e.g. v0.18.0)")
    .optional(),
});

export type AssistedUpdateMetadata = z.infer<
  typeof AssistedUpdateMetadataSchema
> & {
  requiredChecks: ReadonlyArray<
    RequiredCheckName | { name: RequiredCheckName; description?: string }
  >;
};

export type AssistedUpdateMetadataInspection =
  | { state: "absent" }
  | { state: "invalid"; error: string }
  | { state: "valid"; metadata: AssistedUpdateMetadata };

const FENCE_RE = /```dispatch-update[ \t]*\r?\n([\s\S]*?)\r?\n```/i;
const EMBEDDED_FENCE_RE = /```/;

/**
 * Parse the structured assisted-update metadata block out of a GitHub release
 * body. Releases that opt in include a fenced block:
 *
 *   ```dispatch-update
 *   { "mode": "required", "title": "...", ... }
 *   ```
 *
 * Returns null when the block is absent or unparseable. The framework treats a
 * missing block as a normal release — the legacy one-click flow handles it.
 */
export function parseAssistedUpdateMetadata(
  body: string | null | undefined
): AssistedUpdateMetadata | null {
  const inspected = inspectAssistedUpdateMetadata(body);
  return inspected.state === "valid" ? inspected.metadata : null;
}

export function inspectAssistedUpdateMetadata(
  body: string | null | undefined
): AssistedUpdateMetadataInspection {
  if (!body) return { state: "absent" };
  const match = body.match(FENCE_RE);
  if (!match) return { state: "absent" };
  const raw = match[1].trim();
  if (!raw) return { state: "invalid", error: "metadata block is empty" };
  const validated = validateAssistedUpdateMetadataJson(raw);
  if (!validated.success) {
    return { state: "invalid", error: validated.error };
  }
  return { state: "valid", metadata: validated.data };
}

export function validateAssistedUpdateMetadataJson(
  raw: string
):
  | { success: true; data: AssistedUpdateMetadata }
  | { success: false; error: string } {
  let parsed: unknown;
  try {
    parsed = parseJsonWithLocation(raw);
  } catch (error) {
    return {
      success: false,
      error: formatJsonParseError(raw, error),
    };
  }

  const result = AssistedUpdateMetadataSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "<root>";
    return {
      success: false,
      error: `metadata schema mismatch at ${path}: ${issue?.message ?? "invalid value"}`,
    };
  }

  const fenceBreaker = findFenceBreakerField(result.data);
  if (fenceBreaker) {
    return {
      success: false,
      error: `metadata field ${fenceBreaker} contains a literal triple-backtick fence`,
    };
  }

  return {
    success: true,
    data: result.data as AssistedUpdateMetadata,
  };
}

export function canonicalizeAssistedUpdateMetadata(
  metadata: AssistedUpdateMetadata
): string {
  const canonical: Record<string, unknown> = {
    mode: metadata.mode,
    title: metadata.title,
    summary: metadata.summary,
  };

  if (metadata.instructions !== undefined) {
    canonical.instructions = metadata.instructions;
  }

  canonical.requiredChecks = [...metadata.requiredChecks];

  if (metadata.rollbackGuidance !== undefined) {
    canonical.rollbackGuidance = metadata.rollbackGuidance;
  }

  if (metadata.appliesFrom !== undefined) {
    canonical.appliesFrom = metadata.appliesFrom;
  }

  return JSON.stringify(canonical, null, 2);
}

export function appendAssistedUpdateMetadataBlock(
  notes: string,
  metadata: AssistedUpdateMetadata
): string {
  const canonical = canonicalizeAssistedUpdateMetadata(metadata);
  const prefix = notes.trimEnd().length > 0 ? `${notes.trimEnd()}\n\n` : "";
  return `${prefix}\`\`\`dispatch-update\n${canonical}\n\`\`\`\n`;
}

/**
 * True when the target release's metadata gates the generic one-click update
 * for an installation currently running `currentTag`. Honors the optional
 * `appliesFrom` rule: if set, only installs at or above that version need the
 * assisted flow (so a downgrade or far-behind install can take a different
 * path).
 */
export function isAssistedUpdateRequired(
  metadata: AssistedUpdateMetadata | null,
  currentTag: string | null
): boolean {
  if (!metadata) return false;
  if (metadata.mode !== "required") return false;
  if (!metadata.appliesFrom) return true;
  if (!currentTag) return true;
  return compareSemver(currentTag, metadata.appliesFrom) >= 0;
}

export function normalizeRequiredChecks(
  metadata: AssistedUpdateMetadata
): RequiredCheckName[] {
  return metadata.requiredChecks.map((c) =>
    typeof c === "string" ? c : c.name
  );
}

function findFenceBreakerField(
  metadata: AssistedUpdateMetadata
):
  | "title"
  | "summary"
  | "instructions"
  | "rollbackGuidance"
  | `requiredChecks.${number}.description`
  | null {
  const proseFields = [
    ["title", metadata.title],
    ["summary", metadata.summary],
    ["instructions", metadata.instructions],
    ["rollbackGuidance", metadata.rollbackGuidance],
  ] as const;

  for (const [field, value] of proseFields) {
    if (typeof value === "string" && EMBEDDED_FENCE_RE.test(value)) {
      return field;
    }
  }

  for (const [index, check] of metadata.requiredChecks.entries()) {
    if (
      typeof check === "object" &&
      typeof check.description === "string" &&
      EMBEDDED_FENCE_RE.test(check.description)
    ) {
      return `requiredChecks.${index}.description`;
    }
  }

  return null;
}

function formatJsonParseError(raw: string, error: unknown): string {
  const base = error instanceof Error ? error.message : "invalid JSON metadata";
  if (/line \d+ column \d+/i.test(base)) {
    return `metadata JSON parse error: ${base}`;
  }

  const positionMatch = /position (\d+)/.exec(base);
  if (!positionMatch) {
    return `metadata JSON parse error: ${base}`;
  }

  const position = Number(positionMatch[1]);
  if (!Number.isFinite(position) || position < 0) {
    return `metadata JSON parse error: ${base}`;
  }

  const slice = raw.slice(0, position);
  const lines = slice.split("\n");
  const line = lines.length;
  const column = (lines.at(-1)?.length ?? 0) + 1;
  return `metadata JSON parse error at line ${line} column ${column}: ${base}`;
}

function parseJsonWithLocation(raw: string): unknown {
  let i = 0;

  const skipWhitespace = () => {
    while (i < raw.length && /\s/.test(raw[i]!)) i++;
  };

  const fail = (message: string, index = i): never => {
    const slice = raw.slice(0, index);
    const lines = slice.split("\n");
    const line = lines.length;
    const column = (lines.at(-1)?.length ?? 0) + 1;
    throw new Error(`${message} at line ${line} column ${column}`);
  };

  const parseValue = (): unknown => {
    skipWhitespace();
    if (i >= raw.length) fail("unexpected end of JSON input");
    const ch = raw[i]!;
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === '"') return parseString();
    if (ch === "-" || /\d/.test(ch)) return parseNumber();
    if (raw.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (raw.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (raw.startsWith("null", i)) {
      i += 4;
      return null;
    }
    fail(`unexpected token ${JSON.stringify(ch)}`);
  };

  const parseObject = (): Record<string, unknown> => {
    const value: Record<string, unknown> = {};
    i++;
    skipWhitespace();
    if (raw[i] === "}") {
      i++;
      return value;
    }
    while (i < raw.length) {
      skipWhitespace();
      if (raw[i] !== '"') fail("expected string key");
      const key = parseString();
      skipWhitespace();
      if (raw[i] !== ":") fail("expected ':' after object key");
      i++;
      value[key] = parseValue();
      skipWhitespace();
      if (raw[i] === "}") {
        i++;
        return value;
      }
      if (raw[i] !== ",") fail("expected ',' or '}' after object entry");
      i++;
    }
    return fail("unterminated object");
  };

  const parseArray = (): unknown[] => {
    const value: unknown[] = [];
    i++;
    skipWhitespace();
    if (raw[i] === "]") {
      i++;
      return value;
    }
    while (i < raw.length) {
      value.push(parseValue());
      skipWhitespace();
      if (raw[i] === "]") {
        i++;
        return value;
      }
      if (raw[i] !== ",") fail("expected ',' or ']' after array entry");
      i++;
    }
    return fail("unterminated array");
  };

  const parseString = (): string => {
    const start = i;
    i++;
    while (i < raw.length) {
      const ch = raw[i]!;
      if (ch === '"') {
        i++;
        try {
          return JSON.parse(raw.slice(start, i)) as string;
        } catch {
          fail("invalid string escape", start);
        }
      }
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "\n" || ch === "\r") fail("unterminated string");
      i++;
    }
    return fail("unterminated string", start);
  };

  const parseNumber = (): number => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      raw.slice(i)
    );
    if (!match) return fail("invalid number");
    i += match[0]!.length;
    return Number(match[0]!);
  };

  const value = parseValue();
  skipWhitespace();
  if (i !== raw.length) {
    fail("unexpected trailing content");
  }
  return value;
}
