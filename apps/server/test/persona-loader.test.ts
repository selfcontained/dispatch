import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendBuiltInPersonas,
  BUILT_IN_PERSONA_SUMMARIES,
  GENERIC_REVIEW_PERSONA_SLUG,
  getBuiltInPersona,
} from "../src/personas/built-in.js";
import {
  assemblePersonaPrompt,
  INLINE_DIFF_THRESHOLD_BYTES,
  loadPersonaBySlug,
  loadPersonas,
  loadPersonasFromRoots,
  mergePersonasWithWorktreePrecedence,
  parseFrontmatter,
} from "../src/personas/loader.js";
import type { PersonaDefinition } from "../src/personas/loader.js";
import type { ReviewDiffResult } from "../src/personas/review-diff.js";

function makeDiffResult(
  diff: string,
  overrides: Partial<ReviewDiffResult> = {}
): ReviewDiffResult {
  return {
    diff,
    stat: overrides.stat ?? "",
    uncommittedStat: overrides.uncommittedStat ?? "",
    untrackedFiles: overrides.untrackedFiles ?? [],
    baseRef: overrides.baseRef ?? "origin/main",
    diffByteSize: overrides.diffByteSize ?? Buffer.byteLength(diff, "utf-8"),
  };
}

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

describe("assemblePersonaPrompt", () => {
  const basePersona: PersonaDefinition = {
    slug: "test-reviewer",
    name: "Test Reviewer",
    description: "A test persona",
    feedbackFormat: "findings",
    body: "# You are a Test Reviewer\n\nReview the code carefully.",
  };

  it("appends feedback guidelines, context, and diff", () => {
    const result = assemblePersonaPrompt(
      basePersona,
      "Built a widget",
      makeDiffResult("diff --git a/foo", { baseRef: "origin/main" })
    );

    expect(result).toContain("# You are a Test Reviewer");
    expect(result).toContain("## Feedback Guidelines (from Dispatch)");
    expect(result).toContain("## Context from parent agent\nBuilt a widget");
    expect(result).toContain("## Changes to review\ndiff --git a/foo");
    expect(result).toContain("git diff origin/main...HEAD");
  });

  it("orders sections correctly: persona body, guidelines, context, diff", () => {
    const result = assemblePersonaPrompt(
      basePersona,
      "ctx",
      makeDiffResult("diff")
    );

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
    const result = assemblePersonaPrompt(
      persona,
      "my context",
      makeDiffResult("my diff")
    );

    expect(result).not.toMatch(/\{\{context\}\}/);
    expect(result).not.toMatch(/\{\{diff\}\}/);
    expect(result).toContain("## Context from parent agent\nmy context");
    expect(result).toContain("## Changes to review\nmy diff");
  });

  it("uses stat summary + git commands for large diffs", () => {
    const largeDiff = "a".repeat(60 * 1024);
    const result = assemblePersonaPrompt(
      basePersona,
      "ctx",
      makeDiffResult(largeDiff, {
        stat: " a.ts | 10 +\n 1 file changed",
        baseRef: "origin/main",
      })
    );

    expect(result).not.toContain(largeDiff);
    expect(result).toContain("too large to include inline");
    expect(result).toContain("a.ts | 10 +");
    expect(result).toContain("git diff origin/main...HEAD -- <path>");
    expect(result).toContain("git diff origin/main...HEAD");
  });

  it("includes uncommitted stat and untracked files for large diffs without committed changes", () => {
    const largeDiff = "a".repeat(60 * 1024);
    const result = assemblePersonaPrompt(
      basePersona,
      "ctx",
      makeDiffResult(largeDiff, {
        stat: "",
        uncommittedStat: " b.ts | 5 +\n 1 file changed",
        untrackedFiles: ["new-feature.ts", "config.json"],
        baseRef: "origin/main",
      })
    );

    expect(result).toContain("too large to include inline");
    expect(result).toContain("Uncommitted working tree changes");
    expect(result).toContain("b.ts | 5 +");
    expect(result).toContain("Untracked files");
    expect(result).toContain("- new-feature.ts");
    expect(result).toContain("- config.json");
    expect(result).not.toContain("Committed changes");
  });

  it("omits file-level summary preamble when no stat sources exist for large diffs", () => {
    const largeDiff = "a".repeat(60 * 1024);
    const result = assemblePersonaPrompt(
      basePersona,
      "ctx",
      makeDiffResult(largeDiff, {
        stat: "",
        uncommittedStat: "",
        untrackedFiles: [],
      })
    );

    expect(result).toContain("too large to include inline");
    expect(result).not.toContain("file-level summary is below");
    expect(result).toContain("git commands below");
  });

  it("inlines small diffs under the threshold", () => {
    const smallDiff = "b".repeat(Math.floor(INLINE_DIFF_THRESHOLD_BYTES * 0.8));
    const result = assemblePersonaPrompt(
      basePersona,
      "ctx",
      makeDiffResult(smallDiff, { baseRef: "origin/main" })
    );

    expect(result).not.toContain("too large to include inline");
    expect(result).toContain(smallDiff);
    expect(result).toContain("git diff origin/main...HEAD -- <path>");
    expect(result).toContain("git diff HEAD");
  });

  it("guides reviewers to keep summaries short and non-duplicative", () => {
    const result = assemblePersonaPrompt(basePersona, "", null);
    expect(result).toContain("dispatch_review_submit");
    expect(result).toContain("280 characters or fewer");
    expect(result).toContain("never repeat feedback-item details");
    expect(result).toContain("empty array and a concise nonblank summary");
  });

  it("keeps review discussion in tracked item threads", () => {
    const result = assemblePersonaPrompt(basePersona, "", null);
    expect(result).toContain("dispatch_review_add_message");
    expect(result).toContain("dispatch_review_add_feedback");
    expect(result).toContain("Do not use direct agent messages");
  });

  it("does not include Cursor tool guidance by default", () => {
    const result = assemblePersonaPrompt(basePersona, "", null);
    expect(result).toContain("Call `dispatch_review_submit`");
    expect(result).not.toContain("dispatch-<tool_name>");
    expect(result).not.toContain("functions.dispatch-review_status");
  });

  it("includes Cursor tool guidance and call syntax hint for Cursor reviewers", () => {
    const result = assemblePersonaPrompt(basePersona, "", null, {
      agentType: "cursor",
    });
    expect(result).toContain("dispatch-<tool_name>");
    expect(result).toContain("report the exact tool error");
    expect(result).toContain("functions.dispatch-dispatch_event");
  });

  it("does not inject the legacy round-trip lifecycle", () => {
    const result = assemblePersonaPrompt(basePersona, "", null);
    expect(result).not.toContain("Recheck round-trip");
    expect(result).not.toContain("dispatch_complete_review");
    expect(result).not.toContain("dispatch_get_recheck_context");
    expect(result).not.toContain("respondsToFeedbackId");
  });

  it("places review guidance before context and diff sections", () => {
    const result = assemblePersonaPrompt(
      basePersona,
      "ctx",
      makeDiffResult("diff")
    );

    const guidanceIdx = result.indexOf("## Feedback Guidelines");
    const contextIdx = result.indexOf("## Context from parent agent");
    const diffIdx = result.indexOf("## Changes to review");
    expect(guidanceIdx).toBeLessThan(contextIdx);
    expect(contextIdx).toBeLessThan(diffIdx);
  });

  it("includes the diff section by default (includeDiff unset)", () => {
    const result = assemblePersonaPrompt(
      basePersona,
      "ctx",
      makeDiffResult("the-diff", { baseRef: "origin/main" })
    );
    expect(result).toContain("## Changes to review\nthe-diff");
    expect(result).toContain("the scope of the changes (the diff below)");
    expect(result).toContain("git diff origin/main...HEAD");
  });

  it("includes the diff section when includeDiff is true", () => {
    const result = assemblePersonaPrompt(
      basePersona,
      "ctx",
      makeDiffResult("the-diff", { baseRef: "origin/main" }),
      { includeDiff: true }
    );
    expect(result).toContain("## Changes to review\nthe-diff");
    expect(result).toContain("the scope of the changes (the diff below)");
    expect(result).toContain("git diff origin/main...HEAD");
  });

  it("omits the diff section when includeDiff is false", () => {
    const result = assemblePersonaPrompt(
      basePersona,
      "ctx",
      makeDiffResult("the-diff"),
      { includeDiff: false }
    );
    expect(result).not.toContain("## Changes to review");
    expect(result).not.toContain("the-diff");
  });

  it("adapts guidance wording when includeDiff is false", () => {
    const result = assemblePersonaPrompt(basePersona, "ctx", null, {
      includeDiff: false,
    });
    expect(result).not.toContain("the diff below");
    expect(result).toContain(
      "the scope of the work under review described in the parent context"
    );
    expect(result).not.toContain(
      "Read the diff carefully first to understand exactly what changed"
    );
    expect(result).toContain(
      "Read the parent context and supplied review target carefully first"
    );
  });

  it("injects consistent actionable-finding and clean-approval guidance", () => {
    const result = assemblePersonaPrompt(
      basePersona,
      "ctx",
      makeDiffResult("the-diff")
    );
    expect(result).toContain(
      "include a concrete suggestion for what to change"
    );
    expect(result).toContain("approve with an empty feedback array");
    expect(result).toContain(
      "an actionable concern or clarifying question that needs a tracked response"
    );
  });

  it("still includes context section when includeDiff is false", () => {
    const result = assemblePersonaPrompt(
      basePersona,
      "Review the PRD for gaps",
      null,
      { includeDiff: false }
    );
    expect(result).toContain(
      "## Context from parent agent\nReview the PRD for gaps"
    );
  });

  it("handles null diffResult gracefully when includeDiff is true", () => {
    const result = assemblePersonaPrompt(basePersona, "ctx", null);
    expect(result).not.toContain("## Changes to review");
    expect(result).toContain("## Context from parent agent");
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
    mkdirSync(path.join(worktreeRoot, ".dispatch", "personas"), {
      recursive: true,
    });
    mkdirSync(path.join(repoRoot, ".dispatch", "personas"), {
      recursive: true,
    });
    writeFileSync(
      path.join(worktreeRoot, ".dispatch", "personas", "security.md"),
      `---
name: Worktree Security
---

# Worktree security`
    );
    writeFileSync(
      path.join(repoRoot, ".dispatch", "personas", "security.md"),
      `---
name: Repo Security
---

# Repo security`
    );
    writeFileSync(
      path.join(repoRoot, ".dispatch", "personas", "release.md"),
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
    mkdirSync(path.join(overrideRoot, ".dispatch", "personas"), {
      recursive: true,
    });
    writeFileSync(
      path.join(
        overrideRoot,
        ".dispatch",
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
