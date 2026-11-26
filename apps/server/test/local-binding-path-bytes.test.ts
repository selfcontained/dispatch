import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  displayPath,
  pathFromWire,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import { BindingStore } from "../../../packages/runner/src/local/bindings.js";
import { checkoutHandlers } from "../../../packages/runner/src/core/checkout.js";
import { workspaceHandlers } from "../../../packages/runner/src/core/workspace.js";
import { localSessionHandlers } from "../../../packages/runner/src/local/sessions.js";
import { bindingFromRow } from "../src/runners/local-bindings.js";
import { resolvePath } from "../src/agents/workspace.js";
import {
  createGitWorktree,
  cleanupGitWorktree,
} from "../src/shared/git/worktree.js";
import {
  checkoutWorkload,
  workspaceWorkload,
} from "./helpers/checkout-workload.js";

const context = {
  emit() {},
  receiveBlob: async () => {
    throw new Error("unused");
  },
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
async function repository(dir: string, marker: string) {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch=main");
  await writeFile(path.join(dir, "marker"), marker);
  git(dir, "add", ".");
  git(
    dir,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--quiet",
    "-m",
    "pin"
  );
}
const row = (
  id: string,
  cwd: string,
  worktreePath: string | null = null,
  workspacePath: string | null = null
) => ({
  id,
  cwd,
  worktreePath,
  workspacePath,
  worktreeBranch: "raw-work",
  baseBranch: "main",
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "binding-bytes-"))
  );
  const raw = path.join(root, "notes "),
    trimmed = path.join(root, "notes");
  for (const [dir, data] of [
    [raw, "raw"],
    [trimmed, "trimmed"],
  ]) {
    await mkdir(path.join(dir, ".agents/personas"), { recursive: true });
    await writeFile(path.join(dir, ".agents/personas/pin.md"), data);
  }
  return { root, raw, trimmed };
}

it("pins main's no-worktree launch/read/write path bytes", async () => {
  const { root, raw, trimmed } = await fixture();
  try {
    // Main validateWorkingDirectory expands ~, stats and returns cwd verbatim;
    // prepareWorkspace without a worktree and runtime.launch retain that cwd.
    const resolved = await resolvePath(raw, async () => "", { git: false });
    expect(resolved.exists).toBe(true);
    expect(displayPath(resolved.resolvedPath)).toBe(raw);
    expect(
      await readFile(path.join(raw, ".agents/personas/pin.md"), "utf8")
    ).toBe("raw");
    await writeFile(path.join(raw, "written"), "main");
    expect(await readFile(path.join(raw, "written"), "utf8")).toBe("main");
    expect(
      await readFile(path.join(trimmed, ".agents/personas/pin.md"), "utf8")
    ).toBe("trimmed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("pins main's separate creation/cleanup trims without changing them", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "binding-main-trim-"))
  );
  const raw = path.join(root, "notes "),
    trimmed = path.join(root, "notes"),
    destination = path.join(root, "launched ");
  try {
    await repository(raw, "raw repo");
    await repository(trimmed, "trimmed repo");
    // origin/main createGitWorktree: cwd.trim(), but resolve the ORIGINAL
    // worktreePath after its trim() emptiness check. No origin/fetch involved.
    const created = await createGitWorktree({
      cwd: raw,
      name: "pin",
      branchName: "launch-pin",
      baseBranch: "main",
      createNewBranch: true,
      updateBase: false,
      worktreePath: destination,
    });
    expect(created.repoRoot).toBe(trimmed);
    expect(created.worktreePath).toBe(destination);
    expect(await readFile(path.join(destination, "marker"), "utf8")).toBe(
      "trimmed repo"
    );
    const calls: string[][] = [];
    await expect(
      cleanupGitWorktree(
        { cwd: destination, baseBranch: "main" },
        async (_command, args) => {
          calls.push(args);
          throw new Error("stop before cleanup");
        }
      )
    ).rejects.toThrow();
    expect(calls[0]).toEqual([
      "-C",
      destination.trim(),
      "rev-parse",
      "--show-toplevel",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps imported bytes for launch, read, write and command binding checks", async () => {
  const { root, raw, trimmed } = await fixture();
  const state = path.join(root, "state"),
    store = new BindingStore(state),
    id = "space-agent";
  let sessions: ReturnType<typeof localSessionHandlers> | undefined;
  try {
    await store.import([bindingFromRow(row(id, raw))]);
    let launched: string | undefined;
    const stop = new Error("captured launch before spawning");
    sessions = localSessionHandlers({
      root: state,
      sweepMs: null,
      boundDirectory: async (key) => {
        const binding = await store.get(key);
        return binding ? (binding.currentPath ?? binding.path) : null;
      },
      entry: {
        command: () => {
          throw new Error("no host");
        },
        wrap: () => {
          throw new Error("no host");
        },
        env: () => ({}),
        ownership: {
          create: (env) => ({ marker: "unused", env }),
          cleanup() {},
          members: () => [],
        },
        prepare: async (_dir, request) => {
          launched = displayPath(request.directory!);
          throw stop;
        },
      },
    });
    await expect(
      sessions.calls!["session.launch"]!({
        session: sessionFromWire(id),
        launchId: "pin",
        engine: "fixture",
        model: null,
        effort: null,
        access: "default",
        resume: null,
        systemText: null,
        firstText: null,
        overflowNotice: null,
        env: {},
        mcp: [],
        owner: null,
      })
    ).rejects.toBe(stop);
    expect(launched).toBe(raw);
    const commands: string[] = [];
    const workload = {
      ...checkoutWorkload,
      run: (async (op, input, options) => {
        if (op === "checkout.exec") {
          commands.push(input.directory);
          return { exitCode: 0, stdout: input.directory, stderr: "" };
        }
        return checkoutWorkload.run(op, input as never, options);
      }) as typeof checkoutWorkload.run,
    };
    const handlers = checkoutHandlers(store, { workload }),
      target = { session: sessionFromWire(id) };
    const read = await handlers["checkout.read"]!(
      {
        target,
        path: ".agents/personas/pin.md",
        encoding: "utf8",
        maxBytes: null,
      },
      context
    );
    expect(read?.data).toBe("raw");
    await handlers["checkout.write"]!(
      {
        target,
        path: ".agents/personas/pin.md",
        data: "written",
        expectedDigest: read!.digest,
      },
      context
    );
    expect(
      await readFile(path.join(raw, ".agents/personas/pin.md"), "utf8")
    ).toBe("written");
    expect(
      await readFile(path.join(trimmed, ".agents/personas/pin.md"), "utf8")
    ).toBe("trimmed");
    await handlers["checkout.exec"]!(
      {
        target,
        guard: { path: ".dispatch/tools.json", digest: "fixture" },
        argv: ["fixture"],
        env: {},
        timeoutMs: null,
        maxOutput: null,
        shell: "direct",
      },
      context
    );
    expect(commands).toEqual([raw]);
    await expect(
      handlers["checkout.write"]!(
        {
          target: { path: pathFromWire(raw) },
          path: ".agents/personas/pin.md",
          data: "forbidden",
          expectedDigest: null,
        },
        context
      )
    ).rejects.toMatchObject({ code: "unsupported" });
  } finally {
    await sessions?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it("observes the exact imported worktree main's archive names", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "binding-archive-bytes-"))
  );
  const repo = path.join(root, "repo"),
    raw = path.join(root, "notes "),
    trimmed = path.join(root, "notes");
  try {
    await repository(repo, "seed");
    git(repo, "worktree", "add", "--quiet", "-b", "raw-work", raw);
    git(repo, "worktree", "add", "--quiet", "-b", "trimmed-work", trimmed);
    await writeFile(path.join(raw, "raw-untracked"), "main must observe this");
    const state = path.join(root, "state"),
      store = new BindingStore(state),
      id = "archive-agent";
    await store.import([bindingFromRow(row(id, raw, raw))]);
    const handlers = workspaceHandlers(state, store, workspaceWorkload);
    const observed = await handlers["workspace.observe"]!(
      { session: sessionFromWire(id) },
      context
    );
    expect(observed.ownership).toBe("owned");
    expect(observed.checkout?.path).toBe(raw);
    expect(observed.checkout?.branch).toBe("raw-work");
    expect(observed.checkout?.uncommittedFiles).toContain("?? raw-untracked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
