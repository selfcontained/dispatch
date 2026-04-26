import { z } from "zod";

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

const FENCE_RE = /```dispatch-update[ \t]*\r?\n([\s\S]*?)\r?\n```/i;

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
  if (!body) return null;
  const match = body.match(FENCE_RE);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = AssistedUpdateMetadataSchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data as AssistedUpdateMetadata;
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

function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v.replace(/^v/, "").split("-")[0]!.split(".").map(Number);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
