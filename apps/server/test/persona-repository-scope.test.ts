/*
 * Personas before a launch on another runner (D7, N24): its project's
 * repository, read on that runner and parsed here. A runner that cannot
 * read it yet (an older peer) or right now leaves today's answer.
 */
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { describe, expect, it, vi } from "vitest";
import {
  launchPersonaScope,
  type PersonaScope,
} from "../src/personas/persona-scope.js";
import { listPersonas, resolvePersona } from "../src/personas/resolve.js";
import { controllerPlacement } from "../src/runners/placement.js";

const files = (content: string) => ({
  hasOrigin: true,
  files: [{ path: ".agents/personas/builder.md", content }],
  warnings: [],
  refreshing: false,
  updatedAt: 1,
  truncated: false,
});

const repository = (
  read: () => Promise<ReturnType<typeof files>>
): PersonaScope => ({
  kind: "repository",
  read: vi.fn(read),
  fallback: { kind: "builtins" },
});

describe("repository personas before a launch", () => {
  it("reads the repository's default branch on the runner", async () => {
    const scope = repository(async () =>
      files("---\ntype: task\nname: B\ndescription: d\n---\nfrom the repo")
    );
    expect((await resolvePersona(scope, "builder", "task")).body).toBe(
      "from the repo"
    );
    const listed = await listPersonas(scope, "task");
    expect(listed.personas.map((p) => p.slug)).toContain("builder");
    expect(
      (scope as Extract<PersonaScope, { kind: "repository" }>).read
    ).toHaveBeenCalledWith([".agents/personas", ".dispatch/personas"], true);
  });

  it.each([
    new RunnerCallError({ code: "unsupported", message: "old peer" }),
    new RunnerCallError({ code: "unavailable", message: "offline" }),
    new RunnerCallError({ code: "invalid", message: "not https" }),
    new Error("connection closed"),
  ])(
    "keeps today's answer when the runner cannot read it (%s)",
    async (failure) => {
      const scope = repository(async () => {
        throw failure;
      });
      await expect(resolvePersona(scope, "builder")).rejects.toThrow(
        'Persona "builder" not found.'
      );
      expect((await resolvePersona(scope, "code-review")).slug).toBe(
        "code-review"
      );
    }
  );

  it("reports any other failure", async () => {
    const scope = repository(async () => {
      throw new RunnerCallError({ code: "failed", message: "fetch failed" });
    });
    await expect(resolvePersona(scope, "builder")).rejects.toThrow(
      "fetch failed"
    );
  });
});

describe("launchPersonaScope (D7)", () => {
  const manager = { checkoutReadRunners: vi.fn(() => ({})) } as never;
  const elsewhere = { runner: "rnr_elsewhere" } as never;

  it("reads a folder only on the controller's runner, as main", () => {
    expect(
      launchPersonaScope(manager, {
        placement: controllerPlacement,
        cwd: "/work",
        repository: "https://example.com/o/r",
        source: "workspace",
      })
    ).toEqual({
      kind: "folder",
      cwd: "/work",
      source: "workspace",
      runners: expect.any(Function),
    });
  });

  it("reads the project's repository on any other runner", () => {
    expect(
      launchPersonaScope(manager, {
        placement: elsewhere,
        cwd: "/srv/checkout",
        projectRoot: "/project",
        repository: "https://example.com/o/r",
      })
    ).toMatchObject({
      kind: "repository",
      fallback: { kind: "project", repoRoot: "/project" },
    });
  });

  it("without a repository, answers as before", () => {
    expect(
      launchPersonaScope(manager, {
        placement: elsewhere,
        cwd: "/srv/checkout",
        projectRoot: "/project",
        repository: null,
      })
    ).toEqual({
      kind: "project",
      repoRoot: "/project",
      runners: expect.any(Function),
    });
  });
});
