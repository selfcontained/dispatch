import Fastify from "fastify";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RunnerCallError } from "@dispatch/runner-protocol/contract";
import { registerLaunchTargetRoutes } from "../src/routes/launch-targets.js";
import { runnerDirectory } from "../src/runners/directory.js";
import { startTestLocalRunner } from "./helpers/local-runner-child.js";
import { enrolledCheckouts } from "../../../packages/runner/src/workload/agents/remote/checkout-operations.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it("lists a folderless project's branches through Local and enrolled workload paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repository-branches-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const hosts = path.join(root, "hosts");
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "base",
    "--allow-empty"
  );
  git("branch", "develop");
  git("clone", "-q", "--bare", source, remote);
  const repository = "https://github.com/fixture/branches";
  const config = path.join(root, "gitconfig");
  execFileSync("git", [
    "config",
    "--file",
    config,
    `url.file://${remote}.insteadOf`,
    repository,
  ]);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const child = startTestLocalRunner(hosts, {
    env: { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" },
  });
  cleanups.push(() => child.stop());
  await child.ready();
  // The enrolled adapter runs the actual runner-worker Git entry under its
  // workload environment; no Local child or Git result is mocked here.
  const entry = path.join(root, "worker.ts");
  const worker = new URL(
    "../../../packages/runner/src/workload/agents/checkout-worker.ts",
    import.meta.url
  ).href;
  await writeFile(
    entry,
    `import { runCheckoutWorker } from ${JSON.stringify(worker)}; await runCheckoutWorker(process.argv.slice(2), { launchProbes: {} as never });`
  );
  const enrolled = enrolledCheckouts(
    {} as never,
    {
      run: async (op, cwd, input) =>
        execFileSync("bun", [entry, op, ...(cwd ? [cwd] : [])], {
          env,
          input: JSON.stringify(input),
          encoding: "utf8",
          timeout: 10_000,
        }),
    } as never,
    new AbortController().signal
  );
  const runners = runnerDirectory({
    child: () => child.session,
    remote: {
      call: async (_runner, op, input) =>
        enrolled.calls[op](input, {} as never),
    } as never,
  });
  const error = vi.fn();
  const logger = {
    level: "silent",
    fatal: vi.fn(),
    error,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child() {
      return this;
    },
  };
  const app = Fastify({ loggerInstance: logger });
  cleanups.push(() => app.close());
  app.get("/api/runners", async () => ({
    runners: [{ id: "fixture", name: "Fixture", status: "online" }],
  }));
  app.get("/api/v1/projects", async () => [{ id: "project", repoRoot: null }]);
  app.get("/api/v1/projects/:id", async () => ({
    id: "project",
    repoRoot: null,
  }));
  app.get("/api/v1/projects/:id/repository", async () => ({ url: repository }));
  await registerLaunchTargetRoutes(app, {
    runners,
    agents: {} as never,
    templates: {} as never,
    tasks: {} as never,
  });
  const targets = (await app.inject("/api/v1/launch-targets")).json().targets;
  for (const target of targets) {
    const result = await app.inject(
      `${target.dataUrl}/branches?projectId=project&directory=%2Fstale`
    );
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual({
      branches: ["main", "develop"],
      defaultBranch: "main",
    });
  }
  expect(
    await child.session.call("git.defaultBranch", { target: { repository } })
  ).toEqual({ branch: "main", currentBranch: null });
  expect(existsSync(path.join(hosts, "repositories"))).toBe(false);
  const cause = new RunnerCallError({
    code: "failed",
    message: "fixture authentication failure",
  });
  vi.spyOn(child.session, "call").mockRejectedValueOnce(cause);
  const failed = await app.inject(
    `${targets[0].dataUrl}/branches?projectId=project`
  );
  expect(failed.statusCode).toBe(500);
  expect(failed.json()).toEqual({ error: "Failed to list remote branches." });
  expect(error).toHaveBeenCalledWith(
    {
      err: cause,
      runnerId: "local",
      projectId: "project",
      target: { repository },
    },
    "Failed to list remote branches."
  );
});
