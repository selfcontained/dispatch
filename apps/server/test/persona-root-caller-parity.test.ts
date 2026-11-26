import Fastify from "fastify";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { listPersonas, resolvePersona } from "../src/personas/resolve.js";
import { personaScopeFor } from "./helpers/persona-scope.js";
import { registerPersonaRoutes } from "../src/routes/personas.js";

async function definition(root: string, body: string) {
  await mkdir(path.join(root, ".agents/personas"), { recursive: true });
  await writeFile(path.join(root, ".agents/personas/root-pin.md"), body);
  await writeFile(path.join(root, ".agents/owners.json"), "{}");
}
const scope = (cwd: string, source: "catalog" | "workspace") =>
  personaScopeFor({ cwd, source });
async function route(cwd: string) {
  const app = Fastify();
  await registerPersonaRoutes(app, {
    agentManager: { checkoutReadRunners: () => ({}) },
    projects: {},
    streams: {},
  } as never);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/personas?" + new URLSearchParams({ cwd }),
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  } finally {
    await app.close();
  }
}

// Main resolves workspace roots independently; catalog fallback uses the Git
// common repository. Pin caller output before replacing either native probe.
it("pins persona and owner roots for repositories, worktrees, plain/missing and relative folders", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "persona-caller-root-"))
  );
  const repo = path.join(root, "repo"),
    plain = path.join(root, "plain");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    await mkdir(repo);
    await mkdir(plain);
    git("init", "--quiet");
    await definition(repo, "primary body");
    git("add", ".");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--quiet",
      "-m",
      "pin"
    );
    const worktree = path.join(root, "worktree");
    git("worktree", "add", "--quiet", "-b", "persona-pin", worktree);
    await definition(worktree, "worktree body");
    await definition(plain, "plain body");
    await mkdir(path.join(repo, "sub"));
    await mkdir(path.join(worktree, "sub"));
    for (const [cwd, workspace, catalog, owners] of [
      [repo, "primary body", "primary body", true],
      [path.join(repo, "sub"), "primary body", "primary body", true],
      [worktree, "worktree body", "primary body", true],
      [path.join(worktree, "sub"), "worktree body", "primary body", true],
      [
        path.relative(process.cwd(), path.join(repo, "sub")),
        "primary body",
        "primary body",
        true,
      ],
      [plain, "plain body", "plain body", false],
      [path.join(root, "missing"), null, null, false],
    ] as const) {
      for (const [source, body] of [
        ["workspace", workspace],
        ["catalog", catalog],
      ] as const) {
        const result = await listPersonas(scope(cwd, source), undefined, true);
        expect(
          result.personas.find((p) => p.slug === "root-pin")?.body ?? null
        ).toBe(body);
        expect(result.warnings).toEqual([]);
        if (body !== null)
          expect(
            (await resolvePersona(scope(cwd, source), "root-pin")).body
          ).toBe(body);
      }
      const response = await route(cwd);
      expect(response.codeowners).toBe(owners);
      expect(
        response.personas.find((p: { slug: string }) => p.slug === "root-pin")
          ?.body ?? null
      ).toBe(workspace);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps workspace/owner roots when common-directory probing is rejected", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "persona-caller-common-"))
  );
  const repo = path.join(root, "repo"),
    bin = path.join(root, "bin"),
    sub = path.join(repo, "sub");
  const originalPath = process.env.PATH,
    originalGit = process.env.T40_REAL_GIT;
  const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  try {
    await mkdir(sub, { recursive: true });
    await mkdir(bin);
    execFileSync(git, ["init", "--quiet", repo]);
    await definition(repo, "independent checkout");
    await writeFile(
      path.join(bin, "git"),
      '#!/bin/sh\ncase "$*" in *--git-common-dir*) exit 1;; esac\nexec "$T40_REAL_GIT" "$@"\n',
      { mode: 0o700 }
    );
    process.env.PATH = bin + ":" + originalPath;
    process.env.T40_REAL_GIT = git;
    expect(
      (await resolvePersona(scope(sub, "workspace"), "root-pin")).body
    ).toBe("independent checkout");
    const response = await route(sub);
    expect(response.codeowners).toBe(true);
    expect(
      response.personas.find((p: { slug: string }) => p.slug === "root-pin")
        .body
    ).toBe("independent checkout");
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalGit === undefined) delete process.env.T40_REAL_GIT;
    else process.env.T40_REAL_GIT = originalGit;
    await rm(root, { recursive: true, force: true });
  }
});
