import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assemblePersonaPrompt,
  loadPersonaBySlug,
  loadPersonas,
  parseFrontmatter,
} from "../src/personas/loader.js";
import type { PersonaDefinition } from "../src/personas/loader.js";

// ── parseFrontmatter ────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  it("parses standard frontmatter", () => {
    const content = `---
name: Test Persona
description: A test persona
feedbackFormat: findings
---

# Body content here`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({
      name: "Test Persona",
      description: "A test persona",
      feedbackFormat: "findings",
    });
    expect(result.body).toBe("# Body content here");
  });

  it("returns empty frontmatter when no delimiters present", () => {
    const content = "# Just a body\nNo frontmatter here.";
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
  });

  it("returns empty frontmatter when closing delimiter is missing", () => {
    const content = "---\nname: Broken\n# Body without closing ---";
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
  });

  it("handles leading whitespace before frontmatter", () => {
    const content = `\n\n---
name: Indented
---

Body`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({ name: "Indented" });
    expect(result.body).toBe("Body");
  });

  it("skips lines without colons", () => {
    const content = `---
name: Valid
this line has no colon
description: Also valid
---

Body`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({ name: "Valid", description: "Also valid" });
  });

  it("handles values containing colons", () => {
    const content = `---
description: Reviews code for: security, correctness
---

Body`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({
      description: "Reviews code for: security, correctness",
    });
  });
});

// ── assemblePersonaPrompt ───────────────────────────────────────────

describe("assemblePersonaPrompt", () => {
  const basePersona: PersonaDefinition = {
    slug: "test-reviewer",
    name: "Test Reviewer",
    description: "A test persona",
    feedbackFormat: "findings",
    body: "# You are a Test Reviewer\n\nReview the code carefully.",
  };

  it("appends feedback guidelines, context, and diff", () => {
    const result = assemblePersonaPrompt(basePersona, "Built a widget", "diff --git a/foo");

    expect(result).toContain("# You are a Test Reviewer");
    expect(result).toContain("## Feedback Guidelines (from Dispatch)");
    expect(result).toContain("## Context from parent agent\nBuilt a widget");
    expect(result).toContain("## Changes to review\ndiff --git a/foo");
  });

  it("orders sections correctly: persona body, guidelines, context, diff", () => {
    const result = assemblePersonaPrompt(basePersona, "ctx", "diff");

    const bodyIdx = result.indexOf("# You are a Test Reviewer");
    const guidelinesIdx = result.indexOf("## Feedback Guidelines");
    const contextIdx = result.indexOf("## Context from parent agent");
    const diffIdx = result.indexOf("## Changes to review");

    expect(bodyIdx).toBeLessThan(guidelinesIdx);
    expect(guidelinesIdx).toBeLessThan(contextIdx);
    expect(contextIdx).toBeLessThan(diffIdx);
  });

  it("strips legacy {{context}} placeholders", () => {
    const persona: PersonaDefinition = {
      ...basePersona,
      body: "# Reviewer\n\n## Context\n{{context}}\n\n## Diff\n{{diff}}",
    };
    const result = assemblePersonaPrompt(persona, "my context", "my diff");

    // Placeholders should be gone from the persona body section
    expect(result).not.toMatch(/\{\{context\}\}/);
    expect(result).not.toMatch(/\{\{diff\}\}/);
    // But the actual values appear in the injected sections
    expect(result).toContain("## Context from parent agent\nmy context");
    expect(result).toContain("## Changes to review\nmy diff");
  });

  it("truncates diffs exceeding 50KB", () => {
    const largeDiff = "a".repeat(60 * 1024);
    const result = assemblePersonaPrompt(basePersona, "ctx", largeDiff);

    expect(result).toContain("[... diff truncated at 50KB ...]");
    // The full 60KB string should not be present
    expect(result).not.toContain(largeDiff);
  });

  it("does not truncate diffs under 50KB", () => {
    const smallDiff = "b".repeat(40 * 1024);
    const result = assemblePersonaPrompt(basePersona, "ctx", smallDiff);

    expect(result).not.toContain("[... diff truncated");
    expect(result).toContain(smallDiff);
  });

  it("includes standard severity levels", () => {
    const result = assemblePersonaPrompt(basePersona, "", "");

    expect(result).toContain("**critical**");
    expect(result).toContain("**high**");
    expect(result).toContain("**medium**");
    expect(result).toContain("**low**");
    expect(result).toContain("**info**");
  });

  it("includes info feedback limits", () => {
    const result = assemblePersonaPrompt(basePersona, "", "");
    expect(result).toContain("Info feedback limits");
    expect(result).toContain("Do NOT submit positive affirmations");
  });
});

// ── loadPersonas / loadPersonaBySlug (filesystem) ───────────────────

describe("loadPersonas", () => {
  const tmpRoot = `/tmp/dispatch-persona-test-${process.pid}`;
  const personasDir = path.join(tmpRoot, ".dispatch", "personas");

  beforeAll(() => {
    mkdirSync(personasDir, { recursive: true });
    writeFileSync(
      path.join(personasDir, "security-review.md"),
      `---
name: Security Review
description: Reviews for vulnerabilities
---

# Security Reviewer

Check for XSS and injection.`
    );
    writeFileSync(
      path.join(personasDir, "design-review.md"),
      `---
name: Design Review
description: Reviews architecture
feedbackFormat: checklist
---

# Design Reviewer`
    );
    writeFileSync(path.join(personasDir, "not-a-persona.txt"), "ignored");
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("loads all .md files from the personas directory", async () => {
    const personas = await loadPersonas(tmpRoot);
    expect(personas).toHaveLength(2);
    const slugs = personas.map((p) => p.slug).sort();
    expect(slugs).toEqual(["design-review", "security-review"]);
  });

  it("ignores non-.md files", async () => {
    const personas = await loadPersonas(tmpRoot);
    expect(personas.every((p) => !p.slug.includes("not-a-persona"))).toBe(true);
  });

  it("parses frontmatter fields correctly", async () => {
    const personas = await loadPersonas(tmpRoot);
    const security = personas.find((p) => p.slug === "security-review")!;
    expect(security.name).toBe("Security Review");
    expect(security.description).toBe("Reviews for vulnerabilities");
    expect(security.feedbackFormat).toBe("findings");
  });

  it("uses custom feedbackFormat when specified", async () => {
    const personas = await loadPersonas(tmpRoot);
    const design = personas.find((p) => p.slug === "design-review")!;
    expect(design.feedbackFormat).toBe("checklist");
  });

  it("returns empty array when directory does not exist", async () => {
    const personas = await loadPersonas("/tmp/nonexistent-dispatch-test");
    expect(personas).toEqual([]);
  });
});

describe("loadPersonaBySlug", () => {
  const tmpRoot = `/tmp/dispatch-persona-slug-test-${process.pid}`;
  const personasDir = path.join(tmpRoot, ".dispatch", "personas");

  beforeAll(() => {
    mkdirSync(personasDir, { recursive: true });
    writeFileSync(
      path.join(personasDir, "test-persona.md"),
      `---
name: Test Persona
description: For testing
---

# Test body`
    );
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("loads a persona by slug", async () => {
    const persona = await loadPersonaBySlug(tmpRoot, "test-persona");
    expect(persona).not.toBeNull();
    expect(persona!.name).toBe("Test Persona");
    expect(persona!.body).toBe("# Test body");
  });

  it("returns null for nonexistent slug", async () => {
    const persona = await loadPersonaBySlug(tmpRoot, "nonexistent");
    expect(persona).toBeNull();
  });

  it("rejects slugs with path traversal", async () => {
    await expect(loadPersonaBySlug(tmpRoot, "../etc/passwd")).rejects.toThrow(
      "Invalid persona slug"
    );
  });

  it("rejects slugs with forward slashes", async () => {
    await expect(loadPersonaBySlug(tmpRoot, "foo/bar")).rejects.toThrow(
      "Invalid persona slug"
    );
  });

  it("rejects slugs with backslashes", async () => {
    await expect(loadPersonaBySlug(tmpRoot, "foo\\bar")).rejects.toThrow(
      "Invalid persona slug"
    );
  });
});
