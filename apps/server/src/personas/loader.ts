import {
  pathFromWire,
  RunnerCallError,
} from "@dispatch/runner-protocol/contract";
import {
  runnerDirectory,
  type CheckoutCommandRunners,
} from "../runners/directory.js";
import { controllerPlacement } from "../runners/placement.js";
import path from "node:path";

import { errorMessage } from "../shared/lib/error-message.js";
import { PERSONA_DIRS } from "./paths.js";

export type PersonaType = "review" | "task";

export function supportsPersonaType(
  persona: { type?: PersonaType },
  type: "review" | "task"
): boolean {
  return (persona.type ?? "review") === type;
}

export type PersonaDefinition = {
  type?: PersonaType;
  /** Filename without extension (used as persona ID) */
  slug: string;
  /** Display name from frontmatter */
  name: string;
  /** Short description from frontmatter */
  description: string;
  /** Raw markdown body (after frontmatter) */
  body: string;
};

type PersonaFrontmatter = {
  type?: string;
  name?: string;
  description?: string;
};

export { MAX_INLINE_FIRST_TEXT_BYTES as MAX_PERSONA_PROMPT_BYTES } from "@dispatch/runner-protocol";
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
  let legacyFeedbackFormat = false;
  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === "feedbackFormat") legacyFeedbackFormat = true;
    // Read this legacy marker without exposing the obsolete metadata.
    if (key && value && key !== "feedbackFormat") {
      frontmatter[key] = value;
    }
  }

  if (legacyFeedbackFormat && frontmatter.type === undefined) {
    frontmatter.type = "review";
  }
  return { frontmatter: frontmatter as PersonaFrontmatter, body };
}

/** Folder/project definitions use native semantics; session readers retain their own ports. */
function folderFiles(root: string, runners: CheckoutCommandRunners) {
  const runner = runnerDirectory(runners).for(controllerPlacement);
  const target = { path: pathFromWire(path.resolve(root)) };
  return {
    async list(dir: string) {
      const reply = await runner.call("checkout.list", {
        target,
        path: dir,
        mode: "native",
      });
      if (!reply.names)
        throw new Error("Runner did not return native directory names.");
      return reply.names;
    },
    async read(file: string) {
      try {
        const reply = await runner.call("checkout.read", {
          target,
          path: file,
          mode: "native",
          encoding: "utf8",
          maxBytes: null,
        });
        return reply?.data ?? null;
      } catch (error) {
        if (
          !(error instanceof RunnerCallError) ||
          error.code !== "failed" ||
          !error.details ||
          typeof error.details !== "object" ||
          Array.isArray(error.details)
        )
          throw error;
        const details = error.details;
        const original = path.join(root, file);
        const message =
          typeof details.path === "string"
            ? error.message.replaceAll(
                "'" + details.path + "'",
                "'" + original + "'"
              )
            : error.message;
        throw Object.assign(new Error(message), {
          code: details.code,
          path: original,
          syscall: details.syscall,
        });
      }
    },
  };
}

export async function loadPersonas(
  repoRoot: string,
  warnings: string[],
  runners: CheckoutCommandRunners
): Promise<PersonaDefinition[]> {
  const files = folderFiles(repoRoot, runners);
  return loadCheckoutPersonas(files.list, files.read, warnings);
}

export async function loadCheckoutPersonas(
  listFiles: (dir: string) => Promise<string[]>,
  readFile: (file: string) => Promise<string | null>,
  warnings: string[]
): Promise<PersonaDefinition[]> {
  const personas: PersonaDefinition[] = [];
  const seen = new Set<string>();

  for (const directory of PERSONA_DIRS) {
    let entries: string[];
    try {
      entries = await listFiles(directory);
    } catch {
      continue;
    }

    for (const file of entries.filter((name) => name.endsWith(".md")).sort()) {
      const slug = file.slice(0, -3);
      if (seen.has(slug)) continue;
      seen.add(slug);
      try {
        const content = await readFile(`${directory}/${file}`);
        if (content !== null) personas.push(toPersonaDefinition(slug, content));
      } catch (error) {
        warnings.push(
          `Could not load persona ${directory}/${file}: ${errorMessage(error)}`
        );
      }
    }
  }

  return personas;
}

export function toPersonaDefinition(
  slug: string,
  content: string
): PersonaDefinition {
  const { frontmatter, body } = parseFrontmatter(content);
  if (frontmatter.type && !["review", "task"].includes(frontmatter.type)) {
    throw new Error(
      `Invalid persona type "${frontmatter.type}" in ${slug}. Expected review or task.`
    );
  }
  return {
    type: (frontmatter.type ?? "review") as PersonaType,
    slug,
    name: frontmatter.name ?? slug,
    description: frontmatter.description ?? "",
    body,
  };
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

export async function loadPersonaBySlug(
  repoRoot: string,
  slug: string,
  runners: CheckoutCommandRunners
): Promise<PersonaDefinition | null> {
  const files = folderFiles(repoRoot, runners);
  return loadPersonaFromCheckout(slug, async (filePath) => {
    try {
      return await files.read(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  });
}

/** Read and parse the first definition present in checkout precedence order. */
export async function loadPersonaFromCheckout(
  slug: string,
  readCheckoutFile: (path: string) => Promise<string | null>
): Promise<PersonaDefinition | null> {
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new Error("Invalid persona slug.");
  }
  for (const personasDir of PERSONA_DIRS) {
    const filePath = `${personasDir}/${slug}.md`;
    try {
      const content = await readCheckoutFile(filePath);
      if (content !== null) return toPersonaDefinition(slug, content);
    } catch (error) {
      throw new Error(
        `Could not read persona ${filePath}: ${errorMessage(error)}`
      );
    }
  }
  return null;
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
