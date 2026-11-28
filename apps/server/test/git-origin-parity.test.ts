import { inferRepositoryUrl } from "../../../packages/runner/src/workload/agents/checkout-worker.js";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";
import { projectRepositoryUrl } from "@dispatch/runner-protocol";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inferProjectRepository } from "../src/agents/remote/repository.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
const cases = [
  [["https://example.com/owner/repo"], "https://example.com/owner/repo"],
  [["git@EXAMPLE.COM:owner/repo.git"], "https://example.com/owner/repo"],
  [["ssh://git@example.com/owner/repo.git"], "https://example.com/owner/repo"],
  [
    ["https://user:password@example.com/owner/repo.git"],
    "https://example.com/owner/repo",
  ],
  [
    ["https://example.com:8443/owner/repo.git"],
    "https://example.com:8443/owner/repo",
  ],
  [["https://example.com/owner/repo/"], "https://example.com/owner/repo"],
  [["https://example.com/owner/repo.git/"], "https://example.com/owner/repo"],
  [["https://example.com/owner/repo", "https://example.com/owner/repo"], null],
  [[], null],
] as const;
async function fixture(repository = true) {
  const cwd = await mkdtemp(join(tmpdir(), "git-origin-parity-"));
  roots.push(cwd);
  if (repository) execFileSync("git", ["init", "--quiet", cwd]);
  return cwd;
}
it.each(cases)(
  "pins main's origin normalization %#",
  async (origins, expected) => {
    const cwd = await fixture();
    for (const origin of origins)
      execFileSync("git", [
        "-C",
        cwd,
        "config",
        "--local",
        "--add",
        "remote.origin.url",
        origin,
      ]);
    expect(await inferProjectRepository(cwd)).toBe(expected);
    const raw = await inferRepositoryUrl(cwd).catch(() => null);
    const answer = await runnerDirectory({})
      .for(controllerPlacement)
      .call("git.origin", { path: cwd });
    expect(answer.url).toBe(raw === null ? null : projectRepositoryUrl(raw));
    expect(answer.url).toBe(expected);
  }
);
it("pins main's non-repository result", async () => {
  expect(await inferProjectRepository(await fixture(false))).toBeNull();
});
it("pins main's include-only origin result", async () => {
  const cwd = await fixture();
  const include = join(cwd, "included-config");
  await writeFile(
    include,
    '[remote "origin"]\nurl = https://example.com/owner/repo.git\n'
  );
  execFileSync("git", [
    "-C",
    cwd,
    "config",
    "--local",
    "include.path",
    include,
  ]);
  expect(await inferProjectRepository(cwd)).toBeNull();
});
