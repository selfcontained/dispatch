import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type PersonaDefinition = {
  /** Filename without extension (used as persona ID) */
  slug: string;
  /** Display name from frontmatter */
  name: string;
  /** Short description from frontmatter */
  description: string;
  /** Feedback format hint (default: "findings") */
  feedbackFormat: string;
  /** Raw markdown body (after frontmatter) */
  body: string;
};

type PersonaFrontmatter = {
  name?: string;
  description?: string;
  feedbackFormat?: string;
};

const PERSONAS_DIR = ".dispatch/personas";
const MAX_DIFF_BYTES = 50 * 1024;

function parseFrontmatter(content: string): { frontmatter: PersonaFrontmatter; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  const fmBlock = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 4).trim();

  const frontmatter: Record<string, string> = {};
  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) {
      frontmatter[key] = value;
    }
  }

  return { frontmatter: frontmatter as PersonaFrontmatter, body };
}

export async function loadPersonas(repoRoot: string): Promise<PersonaDefinition[]> {
  const dir = path.join(repoRoot, PERSONAS_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md")).sort();
  const personas: PersonaDefinition[] = [];

  for (const file of mdFiles) {
    const content = await readFile(path.join(dir, file), "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);
    const slug = file.replace(/\.md$/, "");

    personas.push({
      slug,
      name: frontmatter.name ?? slug,
      description: frontmatter.description ?? "",
      feedbackFormat: frontmatter.feedbackFormat ?? "findings",
      body,
    });
  }

  return personas;
}

export async function loadPersonaBySlug(
  repoRoot: string,
  slug: string
): Promise<PersonaDefinition | null> {
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new Error("Invalid persona slug.");
  }
  const filePath = path.join(repoRoot, PERSONAS_DIR, `${slug}.md`);
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter(content);
  return {
    slug,
    name: frontmatter.name ?? slug,
    description: frontmatter.description ?? "",
    feedbackFormat: frontmatter.feedbackFormat ?? "findings",
    body,
  };
}

/**
 * Standard feedback guidance injected into every persona prompt.
 * This ensures consistent severity definitions and feedback hygiene
 * regardless of what the repo-specific persona markdown contains.
 */
const STANDARD_FEEDBACK_GUIDANCE = `
## Feedback Guidelines (from Dispatch)

### How to submit feedback
- Call \`dispatch_feedback\` for each finding with: severity, file path, line number, description, and a concrete suggestion.
- Only flag issues that are within the scope of the changes (the diff below). Do not flag pre-existing issues unless directly caused or worsened by the new changes.
- Call \`dispatch_event\` with type \`done\` when your review is complete.

### Severity levels
- **critical**: Exploitable vulnerability, data loss risk, or broken core functionality
- **high**: Significant issue that should be fixed before merge
- **medium**: Missing validation, weak error handling, or correctness concern
- **low**: Minor issue, hardening opportunity, or improvement suggestion
- **info**: Non-obvious good decision that a future contributor might mistakenly undo

### Info feedback limits
Keep \`info\` severity feedback to a maximum of 2–3 items per review. Only use info for decisions that are *surprisingly good* or that need to be *preserved* — do not submit info feedback for code that is simply correct or working as expected. The goal is signal, not a checklist of everything that passed inspection.
`.trim();

export function assemblePersonaPrompt(
  persona: PersonaDefinition,
  context: string,
  diff: string
): string {
  let truncatedDiff = diff;
  if (Buffer.byteLength(diff, "utf-8") > MAX_DIFF_BYTES) {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    truncatedDiff =
      decoder.decode(Buffer.from(diff, "utf-8").subarray(0, MAX_DIFF_BYTES)) +
      "\n\n[... diff truncated at 50KB ...]";
  }

  // Strip legacy {{context}} and {{diff}} placeholders if present — Dispatch
  // now appends these sections automatically so persona files don't need them.
  const personaBody = persona.body
    .replace(/\{\{context\}\}/g, "")
    .replace(/\{\{diff\}\}/g, "");

  return [
    personaBody.trimEnd(),
    STANDARD_FEEDBACK_GUIDANCE,
    `## Context from parent agent\n${context}`,
    `## Changes to review\n${truncatedDiff}`,
  ].join("\n\n");
}
