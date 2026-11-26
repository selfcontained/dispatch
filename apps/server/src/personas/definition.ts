export type PersonaType = "review" | "task";

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
