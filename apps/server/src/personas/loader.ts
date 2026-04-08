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

export function parseFrontmatter(content: string): { frontmatter: PersonaFrontmatter; body: string } {
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
- **Every finding MUST include a concrete suggestion** — what specifically should be changed and how. Findings without suggestions are not actionable and will be ignored.
- Only flag issues that are within the scope of the changes (the diff below). Do not flag pre-existing issues unless directly caused or worsened by the new changes.

### What NOT to submit
- **No praise or affirmation feedback.** Do not submit feedback items that say code is "good", "well-written", "correct", "secure", or "properly handled". Positive observations are not findings — they waste reviewer time and bury real issues. If you have nothing to flag, submit fewer items. Quality over quantity.
- **No pre-existing issues.** If a pattern or vulnerability existed before this diff, it is out of scope. Only flag it if the new changes make it worse or introduce a new instance of it.
- **No vague observations.** "This could be improved" without a specific suggestion is not useful. Every item must say what to change and how.

### Review lifecycle
- Call \`review_status\` with status \`reviewing\` and a short message when you begin reviewing.
- Call \`dispatch_feedback\` for each finding as you go.
- When finished, call \`review_status\` with status \`complete\`, a \`verdict\` (\`approve\` or \`request_changes\`), and a \`summary\` of your findings.
- Then call \`dispatch_event\` with type \`done\`.

### Severity levels
- **critical**: Exploitable vulnerability, data loss risk, or broken core functionality
- **high**: Significant issue that should be fixed before merge
- **medium**: Missing validation, weak error handling, or correctness concern
- **low**: Minor issue, hardening opportunity, or improvement suggestion
- **info**: Non-obvious good decision that a future contributor might mistakenly undo — use sparingly

### Info feedback limits
Keep \`info\` severity feedback to a maximum of 2 items per review. Only use info for decisions that are *surprisingly good* and that a future contributor might mistakenly undo — the kind of thing worth a code comment. Do not submit info feedback for code that is simply correct, working as expected, or follows standard patterns. When in doubt, don't submit it.
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
