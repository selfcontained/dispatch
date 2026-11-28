/*
 * A repository whose default branch is not `main`: a saved launch with no
 * explicit base starts from the repository's default branch on Local and on
 * a runner, an explicit base is used as saved, and a folder keeps main's
 * default. The real Local runner prepares the checkout.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  displayPath,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import {
  resolveCheckoutIntent,
  toRunnerCheckout,
} from "../src/agents/checkout-intent.js";
import { storedLocation } from "../src/runners/saved-location.js";
import { runCommand } from "../src/shared/lib/run-command.js";
import { resolveTemplateLaunch } from "../src/templates/resolve-launch.js";
import type { TemplateRecord } from "../src/templates/store.js";
import { templateWorktreeConfig } from "../src/templates/worktree-config.js";
import { startTestLocalRunner } from "./helpers/local-runner-child.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const git = async (cwd: string, ...args: string[]) =>
  (await runCommand("git", ["-C", cwd, ...args])).stdout.trim();

function template(
  location: TemplateRecord[typeof storedLocation],
  baseBranch: string | null
): TemplateRecord {
  return {
    id: "tpl",
    name: "Worktree",
    directory: location && "path" in location ? location.path : "",
    projectId: location && "projectId" in location ? location.projectId : null,
    description: null,
    prompt: "work",
    agentType: "codex",
    model: null,
    effort: null,
    persona: null,
    useWorktree: true,
    baseBranch,
    branchName: null,
    fullAccess: false,
    callable: true,
    allowFiles: true,
    selfImprove: false,
    createdAt: "",
    updatedAt: "",
    [storedLocation]: location,
  } as TemplateRecord;
}

/** What a saved template's launch asks the runner to check out. */
async function launchCheckout(saved: TemplateRecord) {
  const resolved = await resolveTemplateLaunch(saved);
  const worktree = templateWorktreeConfig(resolved);
  const { checkout } = await resolveCheckoutIntent(
    {
      useWorktree: worktree.useWorktree,
      baseBranch: worktree.baseBranch,
      worktreeBranch: worktree.worktreeBranch,
    },
    // A repository source has no folder to read a default from.
    { id: "agt_default", name: "Worktree" }
  );
  return { resolved, checkout: checkout && toRunnerCheckout(checkout) };
}

it.each([
  ["Local", { runner: "local", projectId: "hello" }],
  ["runner", { runner: "rnr_fixture", projectId: "hello" }],
])(
  "lets the repository choose the base for a %s repository project with no saved base",
  async (_name, location) => {
    const { resolved, checkout } = await launchCheckout(
      template(location, null)
    );
    expect(resolved.baseBranch).toBeNull();
    expect(checkout).toEqual({
      kind: "new",
      branch: "agt_default/worktree",
    });
    const explicit = await launchCheckout(template(location, "master"));
    expect(explicit.checkout).toMatchObject({ kind: "new", base: "master" });
  }
);

it("keeps main's default base for a folder template", async () => {
  const { resolved } = await launchCheckout(
    template({ runner: "local", path: "/work/repo" }, null)
  );
  expect(resolved.baseBranch).toBe("main");
});

it("prepares a Local worktree from the repository's default branch when it is master", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "repo-default-branch-"))
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  await mkdir(source);
  await git(source, "init", "-q", "-b", "master");
  await git(source, "config", "user.name", "Test");
  await git(source, "config", "user.email", "test@example.test");
  await writeFile(path.join(source, "README"), "hello\n");
  await git(source, "add", ".");
  await git(source, "commit", "-qm", "base");
  const head = await git(source, "rev-parse", "HEAD");
  await git(root, "clone", "-q", "--bare", source, remote);
  const repository = "https://github.com/fixture/hello-world";
  const config = path.join(root, "gitconfig");
  await runCommand("git", [
    "config",
    "--file",
    config,
    `url.file://${remote}.insteadOf`,
    repository,
  ]);
  const child = startTestLocalRunner(path.join(root, "hosts"), {
    env: { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
  });
  cleanups.push(() => child.stop());
  await child.ready();

  const { checkout } = await launchCheckout(
    template({ runner: "local", projectId: "hello" }, null)
  );
  const prepare = (session: string, plan: typeof checkout) =>
    child.session.call("workspace.prepare", {
      session: sessionFromWire(session),
      source: { repository, checkout: plan! },
      copyIgnored: [],
      installDependencies: false,
    });
  const prepared = await prepare("agt_default_base", checkout);
  const worktree = displayPath(prepared.path);
  expect(await git(worktree, "rev-parse", "HEAD")).toBe(head);
  expect(await git(worktree, "branch", "--show-current")).toBe(
    "agt_default/worktree"
  );
  await child.session.call("session.discard", {
    session: sessionFromWire("agt_default_base"),
  });

  // An explicit base is used as saved; the old hard-coded main is refused.
  const explicit = await prepare("agt_master_base", {
    kind: "new",
    branch: "feature/master",
    base: "master",
  });
  expect(await git(displayPath(explicit.path), "rev-parse", "HEAD")).toBe(head);
  await child.session.call("session.discard", {
    session: sessionFromWire("agt_master_base"),
  });
  await expect(
    prepare("agt_main_base", {
      kind: "new",
      branch: "feature/main",
      base: "main",
    })
  ).rejects.toThrow(/main/);
});
