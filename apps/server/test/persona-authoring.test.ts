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

  it("warns about large multibyte personas before the inline budget is reached", async () => {
    const root = await makeRoot();
    await upsertPersona({
      root,
      slug: "large",
      name: "Large",
      description: "Review",
      instructions: "é".repeat(24 * 1024),
    });
    const [result] = await validatePersonas(root);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("48KiB"))).toBe(
      true
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
      path: ".agents/personas/payments-review.md",
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
    const invalidPath = path.join(root, ".agents", "personas", "legacy.md");
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

  it("updates a legacy-only persona in place and writes new ones to .agents", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, ".dispatch", "personas"), { recursive: true });
    await writeFile(
      path.join(root, ".dispatch", "personas", "legacy.md"),
      "---\nname: Old\ndescription: Old.\n---\n\nOld.\n"
    );

    const updated = await upsertPersona({
      root,
      slug: "legacy",
      name: "Legacy",
      description: "Updated.",
      instructions: "Updated.",
    });
    const created = await upsertPersona({
      root,
      slug: "fresh",
      name: "Fresh",
      description: "New.",
      instructions: "New.",
    });

    expect(updated).toMatchObject({
      path: ".dispatch/personas/legacy.md",
      created: false,
    });
    expect(created.path).toBe(".agents/personas/fresh.md");
    expect(
      await readFile(path.join(root, ".dispatch/personas/legacy.md"), "utf8")
    ).toContain("description: Updated.");
  });

  it("warns about legacy persona files and flags shadowed copies", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, ".dispatch", "personas"), { recursive: true });
    for (const slug of ["moved", "shadowed"]) {
      await writeFile(
        path.join(root, ".dispatch", "personas", `${slug}.md`),
        `---\nname: ${slug}\ndescription: Legacy.\n---\n\nLegacy.\n`
      );
    }
    await upsertPersona({
      root,
      slug: "shadowed",
      name: "Shadowed",
      description: "Current.",
      instructions: "Current.",
    });

    const results = await validatePersonas(root);
    // The legacy copy exists, so the upsert updated it in place.
    expect(results.map((result) => result.path)).toEqual([
      ".dispatch/personas/moved.md",
      ".dispatch/personas/shadowed.md",
    ]);
    await mkdir(path.join(root, ".agents", "personas"), { recursive: true });
    await writeFile(
      path.join(root, ".agents", "personas", "shadowed.md"),
      "---\nname: Shadowed\ndescription: Current.\n---\n\nCurrent.\n"
    );
    const withShadow = await validatePersonas(root);
    expect(
      withShadow.find((result) => result.path === ".dispatch/personas/moved.md")
        ?.warnings
    ).toContain(
      ".dispatch/personas/ is a legacy location; move this file to .agents/personas/."
    );
    expect(
      withShadow.find(
        (result) => result.path === ".dispatch/personas/shadowed.md"
      )?.warnings
    ).toContain(
      "Ignored: .agents/personas/shadowed.md takes precedence. Delete this legacy copy."
    );
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
    await symlink(external, path.join(root, ".agents"));

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
    await mkdir(path.join(root, ".agents", "personas"), { recursive: true });
    await writeFile(external, "outside content\n");
    await symlink(
      external,
      path.join(root, ".agents", "personas", "security.md")
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
