import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveProjectRoot } from "../src/routes/projects.js";
import { startTestLocalRunner } from "./helpers/local-runner-child.js";

it("anchors a relative controller folder before a child with a different cwd reads it", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "project-root-child-cwd-"))
  );
  const folder = path.join(root, "plain");
  await mkdir(folder);
  const childCwd = path.join(
    root,
    "child",
    ...Array.from({ length: 32 }, () => "deep")
  );
  await mkdir(childCwd, { recursive: true });
  const state = path.join(root, "state");
  await mkdir(state);
  const child = startTestLocalRunner(state, {
    env: { RUNNER_FIXTURE_CWD: childCwd },
  });
  try {
    await vi.waitFor(() => expect(child.current()).not.toBeNull(), {
      timeout: 5_000,
    });
    await child.session.call(
      "runner.describe",
      {},
      { signal: AbortSignal.timeout(5_000) }
    );
    const registry = { child: () => child.session };
    const input = path.relative(process.cwd(), folder);
    const call = vi.spyOn(child.session, "call");
    expect(await resolveProjectRoot(input, registry)).toBe(folder);
    expect(call).toHaveBeenCalledWith(
      "path.resolve",
      {
        path: `${process.cwd()}${path.sep}${input}`,
        git: false,
        projectRoot: true,
      },
      { wait: false }
    );
    const missing = path.relative(process.cwd(), path.join(root, "missing"));
    // Compare with main's unchanged helper in the same Bun runtime as the real
    // app/child. Node and Bun label a failed realpath differently.
    const native = new URL("../src/projects/resolve-root.ts", import.meta.url)
      .href;
    const code = `import { resolveProjectRoot } from ${JSON.stringify(native)}; try { await resolveProjectRoot(${JSON.stringify(missing)}); } catch (error) { console.log(JSON.stringify(error.message)); }`;
    const expected = JSON.parse(
      execFileSync("bun", ["--no-env-file", "-e", code], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      })
    );
    const failure = await resolveProjectRoot(missing, registry).catch(
      (error: Error) => error
    );
    expect((failure as Error).message).toBe(expected);
  } finally {
    await child.stop();
    await rm(root, { recursive: true, force: true });
  }
});
