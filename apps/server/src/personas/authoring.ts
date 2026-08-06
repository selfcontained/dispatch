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

import { parseFrontmatter } from "./loader.js";

const PERSONAS_DIR = ".dispatch/personas";
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

async function ensureSafePersonaDirectory(root: string): Promise<string> {
  const realRoot = await realpath(root);
  let current = realRoot;
  for (const segment of [".dispatch", "personas"]) {
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
  const directory = await ensureSafePersonaDirectory(input.root);
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
    path: path.join(PERSONAS_DIR, `${input.slug}.md`),
    created: !existed,
    content,
  };
}

export async function validatePersonas(
  root: string
): Promise<PersonaValidation[]> {
  const directory = path.join(root, PERSONAS_DIR);
  const files = await readdir(directory).catch(() => [] as string[]);
  return Promise.all(
    files
      .filter((file) => file.endsWith(".md"))
      .sort()
      .map(async (file) => {
        const content = await readFile(path.join(directory, file), "utf8");
        const slug = file.slice(0, -3);
        const { frontmatter, body } = parseFrontmatter(content);
        const errors: string[] = [];
        const warnings: string[] = [];
        try {
          validatePersonaSlug(slug);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
        if (!frontmatter.name?.trim())
          errors.push("Missing required frontmatter field: name.");
        if (!frontmatter.description?.trim())
          errors.push("Missing required frontmatter field: description.");
        if (!body.trim())
          errors.push("Persona instructions must not be empty.");
        if (!frontmatter.feedbackFormat)
          warnings.push("feedbackFormat is omitted; it defaults to findings.");
        return {
          slug,
          path: path.join(PERSONAS_DIR, file),
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
