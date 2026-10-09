import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import { errorMessage } from "../shared/lib/error-message.js";
import { parseFrontmatter, PERSONA_SIZE_WARNING_BYTES } from "./loader.js";
import { LEGACY_PERSONAS_DIR, PERSONA_DIRS, PERSONAS_DIR } from "./paths.js";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type PersonaTemplate = {
  id: string;
  description: string;
  name: string;
  personaDescription: string;
  instructions: string;
};

export const PERSONA_TEMPLATES: PersonaTemplate[] = [
  {
    id: "code-review",
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
    description: "A product and UX reviewer for user-facing flows and clarity.",
    name: "Product & UX Review",
    personaDescription:
      "Reviews user-facing changes for workflow gaps, clarity, and accessibility.",
    instructions:
      "Review the changes from the user's perspective. Check the main flow, empty and error states, wording, accessibility, and mobile behavior when relevant. Flag only user-impacting issues introduced or worsened by this work, with a concrete scenario for each finding.",
  },
  {
    id: "domain-review",
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
  feedbackFormat?: string;
}): string {
  const feedbackFormat = input.feedbackFormat ?? "findings";
  if (!feedbackFormat.trim() || /[\r\n]/.test(feedbackFormat)) {
    throw new Error("feedbackFormat must be non-empty single-line text.");
  }
  return `---\nname: ${input.name}\ndescription: ${input.description}\nfeedbackFormat: ${feedbackFormat}\n---\n\n${input.instructions.trim()}\n`;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * New personas go in `.agents/personas/`. A persona that so far exists only
 * in the legacy directory is updated where it is, so a stale copy is not left
 * shadowed behind the new one.
 */
async function personaDirectoryFor(root: string, slug: string) {
  const inNew = await lstat(path.join(root, PERSONAS_DIR, `${slug}.md`)).catch(
    () => null
  );
  const inLegacy = await lstat(
    path.join(root, LEGACY_PERSONAS_DIR, `${slug}.md`)
  ).catch(() => null);
  return !inNew && inLegacy ? LEGACY_PERSONAS_DIR : PERSONAS_DIR;
}

async function ensureSafePersonaDirectory(
  root: string,
  personasDir: string
): Promise<string> {
  const realRoot = await realpath(root);
  let current = realRoot;
  for (const segment of personasDir.split("/")) {
    current = path.join(current, segment);
    const entry = await lstat(current).catch(() => null);
    if (entry?.isSymbolicLink()) {
      throw new Error(
        `Refusing to write through symlinked persona directory: ${segment}.`
      );
    }
    if (!entry) await mkdir(current);
    const realCurrent = await realpath(current);
    if (!isWithin(realRoot, realCurrent)) {
      throw new Error(
        "Persona directory must remain inside the current workspace."
      );
    }
  }
  return current;
}

export async function upsertPersona(input: {
  root: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  feedbackFormat?: string;
}): Promise<{ path: string; created: boolean; content: string }> {
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
  const content = renderPersona(input);
  const personasDir = await personaDirectoryFor(input.root, input.slug);
  const directory = await ensureSafePersonaDirectory(input.root, personasDir);
  const filePath = path.join(directory, `${input.slug}.md`);
  const entry = await lstat(filePath).catch(() => null);
  if (entry?.isSymbolicLink()) {
    throw new Error("Refusing to overwrite a symlinked persona file.");
  }
  const existed = entry !== null;
  const handle = await open(
    filePath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o644
  );
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  return {
    path: path.join(personasDir, `${input.slug}.md`),
    created: !existed,
    content,
  };
}

export async function validatePersonas(
  root: string
): Promise<PersonaValidation[]> {
  const entries: Array<{ personasDir: string; file: string }> = [];
  for (const personasDir of PERSONA_DIRS) {
    const files = await readdir(path.join(root, personasDir)).catch(
      () => [] as string[]
    );
    for (const file of files.filter((name) => name.endsWith(".md")).sort()) {
      entries.push({ personasDir, file });
    }
  }
  const primarySlugs = new Set(
    entries
      .filter((entry) => entry.personasDir === PERSONAS_DIR)
      .map((entry) => entry.file.slice(0, -3))
  );
  return Promise.all(
    entries.map(async ({ personasDir, file }) => {
      const content = await readFile(
        path.join(root, personasDir, file),
        "utf8"
      );
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
      if (!frontmatter.name?.trim())
        errors.push("Missing required frontmatter field: name.");
      if (!frontmatter.description?.trim())
        errors.push("Missing required frontmatter field: description.");
      if (!body.trim()) errors.push("Persona instructions must not be empty.");
      if (Buffer.byteLength(body, "utf8") >= PERSONA_SIZE_WARNING_BYTES)
        warnings.push(
          "Persona instructions are at least 48KiB. The complete launch context may exceed the 64KiB inline budget and require the reviewer to read a private context file; no content will be trimmed."
        );
      if (!frontmatter.feedbackFormat)
        warnings.push("feedbackFormat is omitted; it defaults to findings.");
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

export function getPersonaTemplate(id: string): PersonaTemplate | undefined {
  return PERSONA_TEMPLATES.find((template) => template.id === id);
}
