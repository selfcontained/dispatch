// Test-only compatibility reference: the former native root authoring implementation.
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

import { errorMessage } from "../../src/shared/lib/error-message.js";
import {
  parseFrontmatter,
  PERSONA_SIZE_WARNING_BYTES,
} from "../../src/personas/loader.js";
import {
  LEGACY_PERSONAS_DIR,
  PERSONA_DIRS,
  PERSONAS_DIR,
} from "../../src/personas/paths.js";

import {
  validatePersonaSlug,
  renderPersona,
  type PersonaValidation,
} from "../../src/personas/authoring.js";

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
  type?: "review" | "task";
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
  const personasDir = await personaDirectoryFor(input.root, input.slug);
  const directory = await ensureSafePersonaDirectory(input.root, personasDir);
  const filePath = path.join(directory, `${input.slug}.md`);
  const entry = await lstat(filePath).catch(() => null);
  if (entry?.isSymbolicLink()) {
    throw new Error("Refusing to overwrite a symlinked persona file.");
  }
  const existed = entry !== null;
  // Editing instructions must not silently turn a task persona into a reviewer.
  const existingType =
    existed && input.type === undefined
      ? (parseFrontmatter(await readFile(filePath, "utf8")).frontmatter.type ??
        "review")
      : undefined;
  const content = renderPersona({
    ...input,
    type: input.type ?? (existingType as "review" | "task" | undefined),
  });
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
  return validateEntries(entries, (file) =>
    readFile(path.join(root, file), "utf8")
  );
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
