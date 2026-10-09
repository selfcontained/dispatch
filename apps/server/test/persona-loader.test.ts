import path from "node:path";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendBuiltInPersonas,
  BUILT_IN_PERSONA_SUMMARIES,
  GENERIC_REVIEW_PERSONA_SLUG,
  getBuiltInPersona,
} from "../src/personas/built-in.js";
import {
  assemblePersonaPrompt,
  buildStandardFeedbackGuidance,
  loadPersonaBySlug,
  loadPersonas,
  loadPersonasFromRoots,
  mergePersonasWithWorktreePrecedence,
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
    expect(result.frontmatter).toEqual({
      name: "Valid",
      description: "Also valid",
    });
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

describe("persona launch context", () => {
  const persona: PersonaDefinition = {
    slug: "reviewer",
    name: "Reviewer",
    description: "Review",
    feedbackFormat: "findings",
    body: "# Persona instructions",
  };

  it("delivers the full persona and briefing without injecting a change map", () => {
    const result = assemblePersonaPrompt(
      persona,
      "Review the attached design for accessibility."
    );
    expect(result).toBe(
      "# Persona instructions\n\n## Context from parent agent\nReview the attached design for accessibility."
    );
    expect(result).not.toContain("git diff");
    expect(result).not.toContain("## Changes to review");
    expect(result).not.toContain("## Feedback Guidelines");
  });

  it("strips legacy context and diff placeholders", () => {
    const result = assemblePersonaPrompt(
      { ...persona, body: "Review {{context}} and {{diff}}" },
      "Supplied target"
    );
    expect(result).not.toContain("{{context}}");
    expect(result).not.toContain("{{diff}}");
    expect(result.match(/Supplied target/g)).toHaveLength(1);
  });

  it("preserves oversized persona and briefing tails", () => {
    const body = "Persona rule.\n".repeat(10000) + "FINAL PERSONA RULE";
    const context = "Briefing line.\n".repeat(10000) + "FINAL BRIEFING RULE";
    const result = assemblePersonaPrompt({ ...persona, body }, context);
    expect(result).toContain(body);
    expect(result).toContain(context);
    expect(result).not.toContain("trimmed");
  });

  it("lets the review target determine whether to inspect diffs", () => {
    const guidance = buildStandardFeedbackGuidance("agt_parent");
    expect(guidance).toContain(
      "For a code-change review, inspect the committed and uncommitted diffs and untracked files"
    );
    expect(guidance).toContain("For other reviews");
    expect(guidance).toContain("a git diff is not required");
    expect(guidance).toContain(
      "Do not flag pre-existing issues unless directly caused or worsened by that work"
    );
    expect(Buffer.byteLength(guidance)).toBeLessThan(4096);
  });

  it("protects submission, thread, and resolution guidance", () => {
    const guidance = buildStandardFeedbackGuidance("agt_parent");
    expect(guidance).toContain('post with to: "agt_parent"');
    expect(guidance).toContain("post exactly one `review` block");
    expect(guidance).toContain("A clean pass is a review with no findings");
    expect(guidance).toContain(
      "Keep each finding's discussion in its own thread"
    );
    expect(guidance).toContain(
      'update({ id: <finding id>, state: { status: "fixed" } })'
    );
    expect(guidance).toContain('{ status: "dismissed", note }');
    expect(guidance).toContain(
      "include a concrete suggestion for what to change"
    );
  });
});

// ── loadPersonas / loadPersonaBySlug (filesystem) ───────────────────

describe("loadPersonas", () => {
  const tmpRoot = `/tmp/dispatch-persona-test-${process.pid}`;
  const personasDir = path.join(tmpRoot, ".agents", "personas");

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

  it("can be safely projected to slug/name/description without leaking body", async () => {
    const personas = await loadPersonas(tmpRoot);
    const projected = personas.map(({ slug, name, description }) => ({
      slug,
      name,
      description,
    }));

    expect(projected).toHaveLength(2);
    for (const p of projected) {
      expect(Object.keys(p).sort()).toEqual(["description", "name", "slug"]);
      expect(p.slug).toBeTruthy();
      expect(p.name).toBeTruthy();
      // Ensure the body text does not leak into the projected fields
      expect(JSON.stringify(p)).not.toContain("# Security Reviewer");
      expect(JSON.stringify(p)).not.toContain("# Design Reviewer");
    }
  });
});

describe("mergePersonasWithWorktreePrecedence", () => {
  const persona = (slug: string, name = slug): PersonaDefinition => ({
    slug,
    name,
    description: "",
    feedbackFormat: "findings",
    body: "",
  });

  it("includes repo personas that are absent from the worktree", () => {
    const merged = mergePersonasWithWorktreePrecedence({
      worktreePersonas: [persona("worktree-only")],
      repoPersonas: [persona("repo-only")],
    });

    expect(merged.map((p) => p.slug)).toEqual(["worktree-only", "repo-only"]);
  });

  it("uses the worktree persona when both roots define the same slug", () => {
    const merged = mergePersonasWithWorktreePrecedence({
      worktreePersonas: [persona("review", "Worktree Review")],
      repoPersonas: [persona("review", "Repo Review"), persona("release")],
    });

    expect(merged).toEqual([
      persona("review", "Worktree Review"),
      persona("release"),
    ]);
  });
});

describe("loadPersonasFromRoots", () => {
  const tmpBase = `/tmp/dispatch-persona-roots-test-${process.pid}`;
  const worktreeRoot = path.join(tmpBase, "worktree");
  const repoRoot = path.join(tmpBase, "repo");

  beforeAll(() => {
    mkdirSync(path.join(worktreeRoot, ".agents", "personas"), {
      recursive: true,
    });
    mkdirSync(path.join(repoRoot, ".agents", "personas"), {
      recursive: true,
    });
    writeFileSync(
      path.join(worktreeRoot, ".agents", "personas", "security.md"),
      `---
name: Worktree Security
---

# Worktree security`
    );
    writeFileSync(
      path.join(repoRoot, ".agents", "personas", "security.md"),
      `---
name: Repo Security
---

# Repo security`
    );
    writeFileSync(
      path.join(repoRoot, ".agents", "personas", "release.md"),
      `---
name: Release
---

# Release`
    );
  });

  afterAll(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("loads both roots and lets the worktree override duplicate slugs", async () => {
    const personas = await loadPersonasFromRoots({ worktreeRoot, repoRoot });

    expect(personas.map((p) => [p.slug, p.name])).toEqual([
      ["security", "Worktree Security"],
      ["release", "Release"],
      [GENERIC_REVIEW_PERSONA_SLUG, "General Code Review"],
    ]);
  });

  it("does not read the repo twice when both roots are the same", async () => {
    const personas = await loadPersonasFromRoots({
      worktreeRoot: repoRoot,
      repoRoot,
    });

    expect(personas.map((p) => p.slug)).toEqual([
      "release",
      "security",
      GENERIC_REVIEW_PERSONA_SLUG,
    ]);
  });

  it("offers the built-in reviewer in a repo with no persona files", async () => {
    const personas = await loadPersonasFromRoots({
      worktreeRoot: "/tmp/dispatch-persona-roots-missing",
      repoRoot: null,
    });

    expect(personas.map((p) => p.slug)).toEqual([GENERIC_REVIEW_PERSONA_SLUG]);
    expect(personas[0]?.body).toContain("General Code Reviewer");
    expect(personas[0]?.feedbackFormat).toBe("findings");
  });

  it("lets a repo file of the same slug replace the built-in", async () => {
    const overrideRoot = path.join(tmpBase, "override");
    mkdirSync(path.join(overrideRoot, ".agents", "personas"), {
      recursive: true,
    });
    writeFileSync(
      path.join(
        overrideRoot,
        ".agents",
        "personas",
        `${GENERIC_REVIEW_PERSONA_SLUG}.md`
      ),
      `---\nname: Repo Code Review\n---\n\n# Repo-specific reviewer`
    );

    const personas = await loadPersonasFromRoots({
      worktreeRoot: overrideRoot,
      repoRoot: overrideRoot,
    });

    expect(personas.map((p) => [p.slug, p.name])).toEqual([
      [GENERIC_REVIEW_PERSONA_SLUG, "Repo Code Review"],
    ]);
  });
});

describe("built-in personas", () => {
  it("resolves the generic reviewer by slug and nothing else", () => {
    const persona = getBuiltInPersona(GENERIC_REVIEW_PERSONA_SLUG);
    expect(persona?.name).toBe("General Code Review");
    expect(persona?.description).not.toBe("");
    expect(getBuiltInPersona("not-a-built-in")).toBeNull();
  });

  it("keeps repo personas ahead of the built-ins it does not override", () => {
    const merged = appendBuiltInPersonas(
      [{ slug: "security" }, { slug: GENERIC_REVIEW_PERSONA_SLUG }],
      [{ slug: GENERIC_REVIEW_PERSONA_SLUG }, { slug: "other-built-in" }]
    );

    expect(merged.map((p) => p.slug)).toEqual([
      "security",
      GENERIC_REVIEW_PERSONA_SLUG,
      "other-built-in",
    ]);
  });

  it("exposes summaries without the persona body", () => {
    for (const summary of BUILT_IN_PERSONA_SUMMARIES) {
      expect(Object.keys(summary).sort()).toEqual([
        "description",
        "name",
        "slug",
      ]);
    }
  });
});

describe("loadPersonaBySlug", () => {
  const tmpRoot = `/tmp/dispatch-persona-slug-test-${process.pid}`;
  const personasDir = path.join(tmpRoot, ".agents", "personas");

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

describe("legacy .dispatch/personas location", () => {
  const tmpRoot = `/tmp/dispatch-persona-legacy-test-${process.pid}`;

  beforeAll(() => {
    mkdirSync(path.join(tmpRoot, ".agents", "personas"), { recursive: true });
    mkdirSync(path.join(tmpRoot, ".dispatch", "personas"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, ".agents", "personas", "security.md"),
      "---\nname: Current Security\ndescription: current\n---\n\ncurrent"
    );
    writeFileSync(
      path.join(tmpRoot, ".dispatch", "personas", "security.md"),
      "---\nname: Legacy Security\ndescription: legacy\n---\n\nlegacy"
    );
    writeFileSync(
      path.join(tmpRoot, ".dispatch", "personas", "release.md"),
      "---\nname: Release\ndescription: legacy only\n---\n\nrelease"
    );
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("reads legacy-only personas and lets .agents win on duplicate slugs", async () => {
    const personas = await loadPersonas(tmpRoot);
    expect(personas.map((p) => [p.slug, p.name])).toEqual([
      ["security", "Current Security"],
      ["release", "Release"],
    ]);
  });

  it("resolves a slug from .agents first, then the legacy directory", async () => {
    expect((await loadPersonaBySlug(tmpRoot, "security"))?.name).toBe(
      "Current Security"
    );
    expect((await loadPersonaBySlug(tmpRoot, "release"))?.name).toBe("Release");
    expect(await loadPersonaBySlug(tmpRoot, "missing")).toBeNull();
  });

  it.skipIf(process.getuid?.() === 0)(
    "does not fall back to the legacy copy when the primary file is unreadable",
    async () => {
      const primary = path.join(tmpRoot, ".agents", "personas", "security.md");
      chmodSync(primary, 0o000);
      try {
        await expect(loadPersonaBySlug(tmpRoot, "security")).rejects.toThrow(
          "Could not read persona .agents/personas/security.md"
        );
      } finally {
        chmodSync(primary, 0o644);
      }
    }
  );
});
