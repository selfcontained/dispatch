import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PERSONA_TEMPLATES,
  upsertPersona,
  validatePersonaSlug,
  validatePersonas,
} from "../src/personas/authoring.js";

describe("persona authoring", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "dispatch-personas-"));
    roots.push(root);
    return root;
  }

  it("offers concise authoring templates", () => {
    expect(PERSONA_TEMPLATES.map((template) => template.id)).toEqual([
      "code-review",
      "product-ux",
      "domain-review",
    ]);
    expect(
      PERSONA_TEMPLATES.every((template) => template.instructions.length > 0)
    ).toBe(true);
  });

  it("writes a valid persona in the workspace", async () => {
    const root = await makeRoot();
    const result = await upsertPersona({
      root,
      slug: "payments-review",
      name: "Payments Review",
      description: "Checks payment invariants.",
      instructions: "Review payment state transitions and idempotency.",
    });

    expect(result).toMatchObject({
      path: ".dispatch/personas/payments-review.md",
      created: true,
    });
    expect(await readFile(path.join(root, result.path), "utf8")).toContain(
      "name: Payments Review"
    );
    expect(await validatePersonas(root)).toEqual([
      expect.objectContaining({
        slug: "payments-review",
        valid: true,
        errors: [],
      }),
    ]);
  });

  it("reports existing permissive personas that lack required authoring metadata", async () => {
    const root = await makeRoot();
    await upsertPersona({
      root,
      slug: "valid",
      name: "Valid",
      description: "Valid persona.",
      instructions: "Inspect changes.",
    });
    const invalidPath = path.join(root, ".dispatch", "personas", "legacy.md");
    await (
      await import("node:fs/promises")
    ).writeFile(invalidPath, "Legacy instructions only.\n");

    const results = await validatePersonas(root);
    expect(results.find((result) => result.slug === "legacy")).toMatchObject({
      valid: false,
      errors: [
        "Missing required frontmatter field: name.",
        "Missing required frontmatter field: description.",
      ],
    });
  });

  it("rejects unsafe persona slugs", () => {
    expect(() => validatePersonaSlug("../outside")).toThrow("Persona slug");
    expect(() => validatePersonaSlug("Security Review")).toThrow(
      "Persona slug"
    );
  });

  it("refuses a symlinked persona directory", async () => {
    const root = await makeRoot();
    const external = await makeRoot();
    await symlink(external, path.join(root, ".dispatch"));

    await expect(
      upsertPersona({
        root,
        slug: "security",
        name: "Security",
        description: "Checks security.",
        instructions: "Inspect authentication.",
      })
    ).rejects.toThrow("symlinked persona directory");
  });

  it("refuses to overwrite a symlinked persona file", async () => {
    const root = await makeRoot();
    const external = path.join(await makeRoot(), "outside.md");
    await mkdir(path.join(root, ".dispatch", "personas"), { recursive: true });
    await writeFile(external, "outside content\n");
    await symlink(
      external,
      path.join(root, ".dispatch", "personas", "security.md")
    );

    await expect(
      upsertPersona({
        root,
        slug: "security",
        name: "Security",
        description: "Checks security.",
        instructions: "Inspect authentication.",
      })
    ).rejects.toThrow("symlinked persona file");
    await expect(readFile(external, "utf8")).resolves.toBe("outside content\n");
  });

  it("does not permit feedbackFormat to inject frontmatter or instructions", async () => {
    await expect(
      upsertPersona({
        root: "/unused",
        slug: "security",
        name: "Security",
        description: "Checks security.",
        instructions: "Inspect authentication.",
        feedbackFormat: "findings\n---\ninjected body",
      })
    ).rejects.toThrow("feedbackFormat");
  });
});
