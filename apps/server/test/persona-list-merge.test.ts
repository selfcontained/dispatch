import { describe, expect, it, vi } from "vitest";

import {
  BUILT_IN_PERSONA_SUMMARIES,
  GENERIC_REVIEW_PERSONA_SLUG,
} from "../src/personas/built-in.js";
import { resolvePersonaList } from "../src/shared/mcp/persona-interaction-tools.js";

const persona = (slug: string, name = slug) => ({
  slug,
  name,
  description: "",
});

const BUILT_IN_SLUGS = new Set(BUILT_IN_PERSONA_SUMMARIES.map((p) => p.slug));

/**
 * Every listing carries the built-ins. These cases are about how the two repo
 * roots merge, so they assert on the repo-defined slice; built-in behavior has
 * its own cases at the bottom.
 */
const defined = <T extends { slug: string }>(personas: T[]): T[] =>
  personas.filter((p) => !BUILT_IN_SLUGS.has(p.slug));

describe("resolvePersonaList", () => {
  it("includes personas from both the worktree and repo root", async () => {
    const listPersonas = vi.fn(async (root: string) =>
      root === "/wt" ? [persona("local")] : [persona("repo")]
    );

    const result = await resolvePersonaList(listPersonas, "/wt", "/repo");

    expect(defined(result).map((p) => p.slug)).toEqual(["local", "repo"]);
    expect(listPersonas).toHaveBeenCalledWith("/wt");
    expect(listPersonas).toHaveBeenCalledWith("/repo");
  });

  it("uses worktree personas as the override for duplicate slugs", async () => {
    const listPersonas = vi.fn(async (root: string) =>
      root === "/wt"
        ? [persona("review", "Worktree Review")]
        : [persona("review", "Repo Review"), persona("release")]
    );

    const result = await resolvePersonaList(listPersonas, "/wt", "/repo");

    expect(defined(result)).toEqual([
      persona("review", "Worktree Review"),
      persona("release"),
    ]);
  });

  it("uses the repo root directly when there is no worktree root", async () => {
    const listPersonas = vi.fn(async (root: string) =>
      root === "/repo" ? [persona("repo")] : []
    );

    const result = await resolvePersonaList(listPersonas, null, "/repo");

    expect(defined(result)).toEqual([persona("repo")]);
    expect(listPersonas).toHaveBeenCalledTimes(1);
    expect(listPersonas).toHaveBeenCalledWith("/repo");
  });

  it("does not re-query when the worktree root and repo root are identical", async () => {
    const listPersonas = vi.fn(async () => [persona("repo")]);

    const result = await resolvePersonaList(listPersonas, "/repo", "/repo");

    expect(defined(result)).toEqual([persona("repo")]);
    expect(listPersonas).toHaveBeenCalledTimes(1);
  });

  it("keeps worktree personas when the repo root listing fails", async () => {
    const listPersonas = vi.fn(async (root: string) => {
      if (root === "/repo") throw new Error("repo unavailable");
      return [persona("local")];
    });

    const result = await resolvePersonaList(listPersonas, "/wt", "/repo");

    expect(defined(result)).toEqual([persona("local")]);
    expect(listPersonas).toHaveBeenCalledTimes(2);
  });

  it("keeps repo personas when the worktree root listing fails", async () => {
    const listPersonas = vi.fn(async (root: string) => {
      if (root === "/wt") throw new Error("worktree unavailable");
      return [persona("repo")];
    });

    const result = await resolvePersonaList(listPersonas, "/wt", "/repo");

    expect(defined(result)).toEqual([persona("repo")]);
    expect(listPersonas).toHaveBeenCalledTimes(2);
  });

  it("returns only the built-ins when neither root is available", async () => {
    const listPersonas = vi.fn(async () => []);

    const result = await resolvePersonaList(listPersonas, null, null);

    expect(result.map((p) => p.slug)).toEqual([GENERIC_REVIEW_PERSONA_SLUG]);
    expect(listPersonas).not.toHaveBeenCalled();
  });

  it("appends the built-in reviewer after repo-defined personas", async () => {
    const listPersonas = vi.fn(async () => [persona("release")]);

    const result = await resolvePersonaList(listPersonas, "/repo", "/repo");

    expect(result.map((p) => p.slug)).toEqual([
      "release",
      GENERIC_REVIEW_PERSONA_SLUG,
    ]);
  });

  it("lets a repo persona of the same slug replace the built-in", async () => {
    const listPersonas = vi.fn(async () => [
      persona(GENERIC_REVIEW_PERSONA_SLUG, "Repo Code Review"),
    ]);

    const result = await resolvePersonaList(listPersonas, "/repo", "/repo");

    expect(result).toEqual([
      persona(GENERIC_REVIEW_PERSONA_SLUG, "Repo Code Review"),
    ]);
  });
});
