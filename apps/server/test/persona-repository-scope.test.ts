/*
 * Personas before a launch on another runner (D7, N24): its project's
 * repository, read on that runner and parsed here. A runner that cannot
 * read it yet (an older peer) or right now answers as a runner session does:
 * built-ins and a warning. The controller's copy never stands in.
 */
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { describe, expect, it, vi } from "vitest";
import {
  launchPersonaScope,
  type PersonaScope,
} from "../src/personas/persona-scope.js";
import { listPersonas, resolvePersona } from "../src/personas/resolve.js";
import {
  controllerPlacement,
  placementForRunner,
} from "../src/runners/placement.js";
import { BUILT_IN_PERSONAS } from "../src/personas/built-in.js";

const RUNNER_WARNING = "Could not read default-branch files from the runner.";

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
    "answers with built-ins and the runner warning when it cannot read (%s)",
    async (failure) => {
      const scope = repository(async () => {
        throw failure;
      });
      const listed = await listPersonas(scope);
      expect(listed.warnings).toEqual([RUNNER_WARNING]);
      expect(listed.personas.map((p) => p.slug).sort()).toEqual(
        BUILT_IN_PERSONAS.map((p) => p.slug).sort()
      );
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
    ).toEqual({ kind: "repository", read: expect.any(Function) });
  });

  it.each([
    ["unreachable", "https://github.com/o/r"],
    ["without a repository", null],
  ])(
    "never reads the controller's copy of the project for a runner target (%s)",
    async (_case, repo) => {
      const call = vi.fn();
      const child = vi.fn(() => ({ call }));
      const runners = {
        checkoutReadRunners: vi.fn(() => ({ child })),
      } as never;
      const scope = launchPersonaScope(runners, {
        placement: placementForRunner("rnr_elsewhere"),
        cwd: "/project",
        projectRoot: "/project",
        repository: repo,
      });
      const listed = await listPersonas(scope, "task");
      expect(listed.warnings).toEqual([RUNNER_WARNING]);
      await expect(resolvePersona(scope, "builder", "task")).rejects.toThrow(
        'Persona "builder" not found.'
      );
      expect(child).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
    }
  );
});
