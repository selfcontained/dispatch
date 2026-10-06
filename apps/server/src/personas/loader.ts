import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { appendBuiltInPersonas, BUILT_IN_PERSONAS } from "./built-in.js";

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

/** Inline ACP context budget; larger launches use a complete private file. */
export const MAX_PERSONA_PROMPT_BYTES = 64 * 1024;
export const PERSONA_SIZE_WARNING_BYTES = 48 * 1024;

export function parseFrontmatter(content: string): {
  frontmatter: PersonaFrontmatter;
  body: string;
} {
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

export async function loadPersonas(
  repoRoot: string
): Promise<PersonaDefinition[]> {
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

export function mergePersonasWithWorktreePrecedence<
  T extends { slug: string },
>(input: { worktreePersonas: T[]; repoPersonas: T[] }): T[] {
  const worktreeSlugs = new Set(input.worktreePersonas.map((p) => p.slug));
  return [
    ...input.worktreePersonas,
    ...input.repoPersonas.filter((p) => !worktreeSlugs.has(p.slug)),
  ];
}

export async function loadPersonasFromRoots(input: {
  worktreeRoot?: string | null;
  repoRoot?: string | null;
}): Promise<PersonaDefinition[]> {
  const worktreeRoot = input.worktreeRoot ?? null;
  const repoRoot = input.repoRoot ?? null;

  const worktreePersonas = worktreeRoot ? await loadPersonas(worktreeRoot) : [];
  const repoPersonas =
    repoRoot && repoRoot !== worktreeRoot ? await loadPersonas(repoRoot) : [];

  return appendBuiltInPersonas(
    mergePersonasWithWorktreePrecedence({
      worktreePersonas,
      repoPersonas,
    }),
    BUILT_IN_PERSONAS
  );
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
 * Standard review guidance injected into every persona prompt.
 * This keeps submission and thread behavior predictable regardless of what
 * the repo-specific persona markdown contains.
 */
export function buildStandardFeedbackGuidance(
  parentAgentId: string | null
): string {
  const target = parentAgentId
    ? `the agent that launched you (post with to: "${parentAgentId}")`
    : "the agent that launched you (post with to set to its id)";

  return `
You are the persona agent assigned by the launcher. Follow the persona and task context delivered with your first message, and use these review instructions when reporting findings.

## Feedback Guidelines (from Dispatch)

### How to review
1. Read the persona instructions, parent briefing, and supplied review target carefully first.
2. Inspect the material relevant to that target. For a code-change review, inspect the committed and uncommitted diffs and untracked files in the worktree, using the base and scope supplied by the launcher. For other reviews, examine the supplied documents, designs, images, or other material; a git diff is not required.
3. Perform any domain-specific investigation described in your persona instructions in the launch context.
4. Collect your findings and post them as described below.

### How to submit feedback
- When the pass is complete, post exactly one \`review\` block to ${target}: \`post({ to, review: { summary, findings: [{ severity, title, body, path, line }] } })\`. Each finding needs a concrete comment and may name a file path and line. A clean pass is a review with no findings; the summary then carries the assessment. The post returns each finding's id.
- Only flag issues within the scope of the work under review described by the persona and parent briefing. Do not flag pre-existing issues unless directly caused or worsened by that work.

### After posting
- Each finding is a block with its own thread. The agent whose work it is answers under a finding with what it changed or why it disagrees, and that reaches you as a prompt. Check the change, then settle the finding yourself, without a closing comment (a note on the resolution carries anything worth saying): \`update({ id: <finding id>, state: { status: "fixed" } })\`, or \`{ status: "dismissed", note }\` when its answer convinces you. If it falls short, reply under the finding with what is still missing (\`post({ replyTo: <finding id>, text })\`); reopen one you settled with \`{ status: "open", note }\`. Where the review stands comes from its findings.
- Keep each finding's discussion in its own thread. A genuinely new concern is a reply under the closest finding, not a second review. If the two of you cannot settle one, ask the user there.

### Feedback hygiene
- Findings are actionable concerns or clarifying questions that need a tracked response. Do not create praise-only or informational findings. Put the overall assessment and useful positive context in the summary instead.
- Make each finding actionable: include a concrete suggestion for what to change. Avoid abstract observations like "this could be cleaner" — specify what the better structure looks like and where to apply it.
`.trim();
}

/** Persona instructions and the launcher's complete briefing; reviewers inspect their target themselves. */
export function assemblePersonaPrompt(
  persona: PersonaDefinition,
  context: string
): string {
  // Remove legacy placeholders. The briefing is appended once; diffs are read locally.
  const personaBody = persona.body
    .replace(/\{\{context\}\}/g, "")
    .replace(/\{\{diff\}\}/g, "");
  return `${personaBody.trimEnd()}\n\n## Context from parent agent\n${context}`;
}
