import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { errorMessage } from "./shared/lib/error-message.js";

/**
 * Persistent install-update migration manifest. Migrations live in
 * `update-migrations/*.yaml` in the source repo, ship inside the release
 * tarball, and are append-only across release history. The runtime evaluates
 * which manifests in a target release have not been applied locally to
 * decide whether assisted update is required (CRU-146).
 */

const MANIFEST_FILE_RE = /^(\d+)-([a-z0-9][a-z0-9-]*)\.ya?ml$/i;

// Deliberately NOT an enum of REQUIRED_CHECK_NAMES. Manifests ship inside
// the *target* release tarball but are parsed by the *currently installed*
// runtime — a strict enum here would make every older install reject a
// manifest the moment a new check name is introduced, silently dropping the
// whole migration from its pending set. Accept any well-formed name at
// parse time; `runRequiredChecks` fails closed on names this runtime
// doesn't implement.
const RequiredCheckSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_]*$/, "check name must be lowercase snake_case");

export const UpdateMigrationManifestSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "id must be lowercase letters, digits, and hyphens"
    ),
  title: z.string().min(1),
  summary: z.string().min(1),
  alreadySatisfied: z.object({
    description: z.string().min(1),
  }),
  instructions: z.array(z.string().min(1)).min(1),
  validation: z.object({
    requiredChecks: z.array(RequiredCheckSchema).default([]),
  }),
  rollback: z.array(z.string().min(1)).default([]),
});

export type UpdateMigrationManifest = z.infer<
  typeof UpdateMigrationManifestSchema
>;

export type UpdateMigrationFile = {
  /** Filename only (e.g. "0001-bun-cutover.yaml"). */
  filename: string;
  /** Numeric prefix used for ordering. */
  order: number;
  /** Parsed + validated manifest body. */
  manifest: UpdateMigrationManifest;
};

export type UpdateMigrationLoadError = {
  filename: string;
  error: string;
};

export type UpdateMigrationLoadResult = {
  migrations: UpdateMigrationFile[];
  errors: UpdateMigrationLoadError[];
};

/**
 * List + parse every migration manifest in a directory. Files are sorted by
 * the numeric prefix in their filename so insertion order in the issue spec
 * (0001-…, 0002-…) survives across deploys. Files that don't match the
 * `<NNNN>-<id>.yaml` shape are ignored. Parse/validation errors are reported
 * as `errors` rather than thrown so the caller can surface them per-file.
 */
export async function loadUpdateMigrations(
  dir: string
): Promise<UpdateMigrationLoadResult> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { migrations: [], errors: [] };
    }
    throw err;
  }

  const matched = entries
    .map((filename) => {
      const m = MANIFEST_FILE_RE.exec(filename);
      if (!m) return null;
      return { filename, order: Number(m[1]) };
    })
    .filter((x): x is { filename: string; order: number } => x !== null)
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.filename.localeCompare(b.filename);
    });

  const migrations: UpdateMigrationFile[] = [];
  const errors: UpdateMigrationLoadError[] = [];
  const seenIds = new Map<string, string>();

  for (const { filename, order } of matched) {
    const filePath = path.join(dir, filename);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      errors.push({
        filename,
        error: errorMessage(err),
      });
      continue;
    }

    const parsed = parseManifest(raw);
    if (!parsed.success) {
      errors.push({ filename, error: parsed.error });
      continue;
    }

    const prior = seenIds.get(parsed.data.id);
    if (prior) {
      errors.push({
        filename,
        error: `duplicate migration id "${parsed.data.id}" (also defined in ${prior})`,
      });
      continue;
    }
    seenIds.set(parsed.data.id, filename);

    migrations.push({ filename, order, manifest: parsed.data });
  }

  return { migrations, errors };
}

export function parseManifest(
  raw: string
):
  | { success: true; data: UpdateMigrationManifest }
  | { success: false; error: string } {
  let yamlValue: unknown;
  try {
    yamlValue = parseYaml(raw);
  } catch (err) {
    const message = errorMessage(err);
    return { success: false, error: `YAML parse error: ${message}` };
  }

  const result = UpdateMigrationManifestSchema.safeParse(yamlValue);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "<root>";
    return {
      success: false,
      error: `manifest schema mismatch at ${where}: ${issue?.message ?? "invalid value"}`,
    };
  }

  return { success: true, data: result.data };
}

/**
 * Filter loaded migrations down to those whose IDs are not yet in
 * `appliedIds`. Preserves load order (already sorted by filename prefix).
 */
export function filterPending(
  migrations: UpdateMigrationFile[],
  appliedIds: ReadonlySet<string>
): UpdateMigrationFile[] {
  return migrations.filter((m) => !appliedIds.has(m.manifest.id));
}
