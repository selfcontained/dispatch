import path from "node:path";

import { errorMessage } from "../shared/lib/error-message.js";
import { parseFrontmatter, PERSONA_SIZE_WARNING_BYTES } from "./loader.js";
import { LEGACY_PERSONAS_DIR, PERSONA_DIRS, PERSONAS_DIR } from "./paths.js";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type PersonaTemplate = {
  type: "review";
  id: string;
  description: string;
  name: string;
  personaDescription: string;
  instructions: string;
};

export const PERSONA_TEMPLATES: PersonaTemplate[] = [
  {
    id: "code-review",
    type: "review",
    description:
      "A focused engineering reviewer for correctness and maintainability.",
    name: "Code Review",
    personaDescription:
      "Reviews changes for correctness, maintainability, and fit with local patterns.",
    instructions:
      "You are a senior engineer reviewing this repository's changes. Verify behavior, error handling, tests, and consistency with nearby code. Flag only concrete issues caused or worsened by the reviewed changes. Explain impact and point to the smallest useful fix.",
  },
  {
    id: "product-ux",
    type: "review",
    description: "A product and UX reviewer for user-facing flows and clarity.",
    name: "Product & UX Review",
    personaDescription:
      "Reviews user-facing changes for workflow gaps, clarity, and accessibility.",
    instructions:
      "Review the changes from the user's perspective. Check the main flow, empty and error states, wording, accessibility, and mobile behavior when relevant. Flag only user-impacting issues introduced or worsened by this work, with a concrete scenario for each finding.",
  },
  {
    id: "domain-review",
    type: "review",
    description:
      "A blank starting point for a repository-specific expert reviewer.",
    name: "Domain Review",
    personaDescription:
      "Reviews changes against this repository's domain-specific constraints.",
    instructions:
      "You are the repository's domain expert. Replace this paragraph with the critical business rules, invariants, data boundaries, and failure modes that reviewers should check. Review only issues introduced or worsened by the changes.",
  },
];

export type PersonaValidation = {
  slug: string;
  path: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export function validatePersonaSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug) || slug.length > 80) {
    throw new Error(
      "Persona slug must use lowercase letters, numbers, and single hyphens (max 80 characters)."
    );
  }
}

export function renderPersona(input: {
  name: string;
  description: string;
  instructions: string;
  type?: "review" | "task";
}): string {
  if (input.type && !["review", "task"].includes(input.type))
    throw new Error("Invalid persona type.");
  return `---\ntype: ${input.type ?? "task"}\nname: ${input.name}\ndescription: ${input.description}\n---\n\n${input.instructions.trim()}\n`;
}

async function validateEntries(
  entries: Array<{ personasDir: string; file: string }>,
  read: (file: string) => Promise<string>
): Promise<PersonaValidation[]> {
  const primarySlugs = new Set(
    entries
      .filter((entry) => entry.personasDir === PERSONAS_DIR)
      .map((entry) => entry.file.slice(0, -3))
  );
  return Promise.all(
    entries.map(async ({ personasDir, file }) => {
      const content = await read(`${personasDir}/${file}`);
      const slug = file.slice(0, -3);
      const { frontmatter, body } = parseFrontmatter(content);
      const errors: string[] = [];
      const warnings: string[] = [];
      if (personasDir === LEGACY_PERSONAS_DIR) {
        warnings.push(
          primarySlugs.has(slug)
            ? `Ignored: ${PERSONAS_DIR}/${file} takes precedence. Delete this legacy copy.`
            : `${LEGACY_PERSONAS_DIR}/ is a legacy location; move this file to ${PERSONAS_DIR}/.`
        );
      }
      try {
        validatePersonaSlug(slug);
      } catch (error) {
        errors.push(errorMessage(error));
      }
      if (frontmatter.type && !["review", "task"].includes(frontmatter.type))
        errors.push("type must be review or task.");
      if (!frontmatter.name?.trim())
        errors.push("Missing required frontmatter field: name.");
      if (!frontmatter.description?.trim())
        errors.push("Missing required frontmatter field: description.");
      if (!body.trim()) errors.push("Persona instructions must not be empty.");
      if (Buffer.byteLength(body, "utf8") >= PERSONA_SIZE_WARNING_BYTES)
        warnings.push(
          "Persona instructions are at least 48KiB. The complete launch context may exceed the 64KiB inline budget and require the reviewer to read a private context file; no content will be trimmed."
        );
      return {
        slug,
        path: path.join(personasDir, file),
        valid: errors.length === 0,
        errors,
        warnings,
      };
    })
  );
}

/**
 * A session's checkout as persona authoring sees it, through its runner:
 * the same reads and one guarded write, on every runner.
 */
export type PersonaFiles = {
  /** A file's text and the digest a write must name to replace it; null when absent. */
  read(path: string): Promise<{ data: string; digest: string } | null>;
  /** The file names in a directory; empty when it does not exist. */
  list(directory: string): Promise<string[]>;
  /**
   * Write `data` only if the file still matches `expectedDigest` (null: it
   * must not exist). Throws a `stale` RunnerCallError otherwise.
   */
  write(
    path: string,
    data: string,
    expectedDigest: string | null
  ): Promise<void>;
};

/** Attempts before reporting that the file kept changing underneath. */
const UPSERT_ATTEMPTS = 3;

const isStale = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === "stale";

/**
 * `upsertPersona` through a session's checkout. Uncontended, it reads and
 * writes exactly what main's in-process write does; when the file changes
 * between the read and the write it reads again, and after
 * `UPSERT_ATTEMPTS` it fails rather than overwrite what someone else wrote.
 */
export async function upsertCheckoutPersona(
  files: PersonaFiles,
  input: {
    slug: string;
    name: string;
    description: string;
    instructions: string;
    type?: "review" | "task";
  }
): Promise<{ path: string; created: boolean; content: string }> {
  validatePersonaSlug(input.slug);
  if (
    !input.name.trim() ||
    !input.description.trim() ||
    !input.instructions.trim()
  ) {
    throw new Error("name, description, and instructions must be non-empty.");
  }
  if (/[\r\n]/.test(input.name) || /[\r\n]/.test(input.description)) {
    throw new Error("name and description must be single-line text.");
  }
  for (let attempt = 1; ; attempt++) {
    const inNew = await files.read(`${PERSONAS_DIR}/${input.slug}.md`);
    const personasDir =
      !inNew && (await files.read(`${LEGACY_PERSONAS_DIR}/${input.slug}.md`))
        ? LEGACY_PERSONAS_DIR
        : PERSONAS_DIR;
    const file = `${personasDir}/${input.slug}.md`;
    const existing =
      personasDir === PERSONAS_DIR ? inNew : await files.read(file);
    const existingType =
      existing && input.type === undefined
        ? (parseFrontmatter(existing.data).frontmatter.type ?? "review")
        : undefined;
    const content = renderPersona({
      ...input,
      type: input.type ?? (existingType as "review" | "task" | undefined),
    });
    try {
      await files.write(file, content, existing?.digest ?? null);
    } catch (error) {
      if (!isStale(error)) throw error;
      if (attempt >= UPSERT_ATTEMPTS)
        throw new Error(
          `${file} kept changing while it was being written. Nothing was overwritten; try again.`
        );
      continue;
    }
    return {
      path: path.join(personasDir, `${input.slug}.md`),
      created: existing === null,
      content,
    };
  }
}

/** `validatePersonas` through a session's checkout. */
export async function validateCheckoutPersonas(
  files: PersonaFiles
): Promise<PersonaValidation[]> {
  const entries: Array<{ personasDir: string; file: string }> = [];
  for (const personasDir of PERSONA_DIRS) {
    const names = await files.list(personasDir);
    for (const file of names.filter((name) => name.endsWith(".md")).sort()) {
      entries.push({ personasDir, file });
    }
  }
  return validateEntries(entries, async (file) => {
    const read = await files.read(file);
    if (read === null)
      throw Object.assign(new Error(`ENOENT: no such file, open '${file}'`), {
        code: "ENOENT",
      });
    return read.data;
  });
}

export function getPersonaTemplate(id: string): PersonaTemplate | undefined {
  return PERSONA_TEMPLATES.find((template) => template.id === id);
}
