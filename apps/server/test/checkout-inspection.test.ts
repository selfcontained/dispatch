import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckoutQuery, CheckoutReply } from "@dispatch/runner-protocol";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { inspectCheckout } from "../src/agents/checkout-inspection.js";
import * as baseRefHelpers from "../src/shared/git/base-ref.js";
import {
  inspectAgentCheckout,
  readAgentStats,
  readAgentView,
} from "../src/agents/checkout-runner.js";
import { agentComparisonBase } from "../src/agents/effective-base.js";
import type { AgentRecord } from "../src/agents/types.js";
import type { DiffResponse } from "@dispatch/shared";
import { createLocalRunner } from "../src/agents/local-runner.js";
import {
  archiveObservation,
  archiveRunner,
} from "../src/agents/archive-checkout.js";
import { controllerPlacement } from "../src/runners/placement.js";
import {
  sessionFromWire,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import { releaseRemoteCheckout } from "../src/agents/archive-checkout.js";
import { cleanupAgentWorktree } from "../src/agents/archive.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";

let scratch: string;
let cli: string;
let fixture: string;
let repo: string;
let checkout: string;
let bin: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function put(root: string, file: string, content: string): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function runCli(cwd: string, input: string) {
  const result = spawnSync(process.execPath, [cli], {
    cwd,
    input,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function subprocess(cwd: string, query: CheckoutQuery): Promise<CheckoutReply> {
  return Promise.resolve().then(() => {
    const result = runCli(cwd, JSON.stringify(query));
    if (result.status !== 0) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      throw new Error(result.stderr.trim());
    }
    expect(result.stderr).toBe("");
    return JSON.parse(result.stdout);
  });
}

beforeAll(() => {
  scratch = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "dispatch-checkout-inspection-"))
  );
  cli = path.join(scratch, "inspect.mjs");
  const entry = path.join(scratch, "entry.ts");
  const implementation = fileURLToPath(
    new URL("../src/agents/checkout-inspection.ts", import.meta.url)
  );
  writeFileSync(
    entry,
    `import { runCheckoutInspectionCli } from ${JSON.stringify(implementation)};\nawait runCheckoutInspectionCli(process.cwd());\n`
  );
  execFileSync("bun", ["build", "--target=node", "--outfile", cli, entry], {
    stdio: "pipe",
  });
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

beforeEach(() => {
  fixture = mkdtempSync(path.join(scratch, "repo-"));
  repo = path.join(fixture, "origin");
  checkout = path.join(fixture, "linked worktree");
  bin = path.join(fixture, "bin");
  mkdirSync(bin);
  mkdirSync(repo);
  vi.stubEnv("PATH", bin + path.delimiter + process.env.PATH);
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
  writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Checkout test");
  git(repo, "config", "commit.gpgsign", "false");
  put(repo, "rename source.txt", "rename");
  put(repo, "cancel.txt", "original");
  put(repo, "deleted.txt", "delete");
  put(repo, "unstaged.txt", "before");
  put(repo, ".gitignore", "ignore.me\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "worktree", "add", "-b", "feature", checkout);
  git(repo, "remote", "add", "origin", repo);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(fixture, { recursive: true, force: true });
});

// On origin/main, agentDiffTarget and resolveReviewBase both start with
// agent.baseBranch when stored. Git prefers origin/<branch> over <branch>.
describe("local existing-branch comparison", () => {
  it.each([
    { name: "ahead with edits", pushed: true, ahead: true, dirty: true },
    { name: "fully pushed", pushed: true },
    { name: "local-only with edits", dirty: true },
    {
      name: "PR head with edits",
      pushed: true,
      ahead: true,
      dirty: true,
      pr: true,
    },
    {
      name: "plain checkout with a stored base",
      pushed: true,
      ahead: true,
      dirty: true,
      plain: true,
    },
    {
      name: "plain checkout with only an upstream",
      pushed: true,
      ahead: true,
      dirty: true,
      plain: true,
      implicit: true,
    },
    {
      name: "plain local-only checkout with no stored base",
      ahead: true,
      dirty: true,
      plain: true,
      implicit: true,
    },
    {
      name: "plain PR head with an upstream and no stored base",
      pushed: true,
      ahead: true,
      dirty: true,
      pr: true,
      plain: true,
      implicit: true,
    },
  ])("$name", async ({ pushed, ahead, dirty, pr, plain, implicit }) => {
    const origin = path.join(fixture, "bare-origin");
    git(fixture, "init", "--bare", origin);
    git(repo, "remote", "set-url", "origin", origin);
    git(repo, "push", "origin", "main");
    if (plain) {
      git(repo, "worktree", "remove", checkout);
      git(repo, "switch", "feature");
    }
    const cwd = plain ? repo : checkout;
    put(cwd, "branch.txt", "branch work\n");
    git(cwd, "add", "branch.txt");
    git(cwd, "commit", "-m", "existing branch work");
    if (pushed) git(cwd, "push", "-u", "origin", "feature");
    if (ahead) {
      put(cwd, "ahead.txt", "unpushed work\n");
      git(cwd, "add", "ahead.txt");
      git(cwd, "commit", "-m", "additional branch work");
    }
    if (dirty) put(cwd, "unstaged.txt", "working tree edit\n");
    if (pr) {
      writeFileSync(
        path.join(bin, "gh"),
        `#!/bin/sh
cat <<'JSON'
{"number":1,"url":"https://example.invalid/pr/1","title":"Test PR","state":"OPEN","isDraft":false,"headRefName":"feature","baseRefName":"main"}
JSON
`
      );
    }

    const agent = {
      id: "agt_local",
      cwd,
      worktreePath: plain ? null : cwd,
      worktreeBranch: plain ? null : "feature",
      baseBranch: implicit ? null : "feature",
    };
    const expectedRef = pushed
      ? "origin/feature"
      : implicit
        ? "origin/main"
        : "feature";
    const expectedCommitted =
      implicit && !pushed
        ? ["ahead.txt", "branch.txt"]
        : ahead && pushed
          ? ["ahead.txt"]
          : [];
    const expectedFiles = dirty
      ? [...expectedCommitted, "unstaged.txt"]
      : expectedCommitted;
    const expectedSha = git(cwd, "rev-parse", expectedRef);

    for (const includeUncommitted of [true, false]) {
      const expected = includeUncommitted ? expectedFiles : expectedCommitted;
      const view = { baseBranch: null, includeUncommitted };
      const diff = (await readAgentView(agent, {
        kind: "diff",
        ...view,
        ignoreWhitespace: false,
      })) as DiffResponse;
      expect(diff.baseRef).toBe(expectedSha);
      expect(diff.files.map((file) => file.path).sort()).toEqual(expected);
      expect(
        await readAgentView(agent, { kind: "stats", ...view })
      ).toMatchObject({
        files: expected.length,
      });
    }
    expect(await readAgentStats(agent.id, agent)).toMatchObject({
      kind: "success",
      stats: { files: expectedFiles.length },
    });
    expect(
      await inspectAgentCheckout(agent as AgentRecord, {
        kind: "changes",
        baseBranch: await agentComparisonBase(agent, "review"),
      })
    ).toMatchObject(
      implicit && pr
        ? {
            baseRef: "origin/main",
            files: [...expectedFiles, "branch.txt"].sort(),
          }
        : { baseRef: expectedRef, files: expectedFiles }
    );
  });
});

describe("native executor base", () => {
  const agent = () => ({
    id: "agt_local",
    cwd: checkout,
    worktreePath: null,
    baseBranch: null,
    workspacePath: null,
  });

  it("attempts origin/main for a native owner review if base probes cannot resolve a ref", async () => {
    git(checkout, "fetch", "origin", "main");
    const resolve = vi
      .spyOn(baseRefHelpers, "resolveBaseRef")
      .mockResolvedValue(null);
    const query = { kind: "changes", baseBranch: "unlisted" } as const;
    try {
      await expect(
        inspectAgentCheckout(agent() as AgentRecord, query)
      ).resolves.toMatchObject({
        baseRef: "origin/main",
      });
      await expect(inspectCheckout(checkout, query)).rejects.toThrow(
        "Could not resolve checkout base"
      );
    } finally {
      resolve.mockRestore();
    }
  });

  it("lists an untracked nested repository for a native owner review like main", async () => {
    put(checkout, "inner/work.txt", "nested work");
    git(path.join(checkout, "inner"), "init", "-q");
    const reply = await inspectAgentCheckout(agent() as AgentRecord, {
      kind: "changes",
      baseBranch: "main",
    });
    expect(reply).toMatchObject({ kind: "changes" });
    expect(reply.kind === "changes" && reply.files).toContain("inner/");
  });

  it("ignores a recorded runner base and falls back like main", async () => {
    git(repo, "branch", "trunk");
    git(checkout, "fetch", "origin", "trunk");
    git(checkout, "config", "branch.feature.dispatchReviewBase", "trunk");
    const query = { kind: "changes", baseBranch: null } as const;
    // A runner checkout still consults the recorded base when sent none.
    expect(await inspectCheckout(checkout, query)).toMatchObject({
      baseRef: "origin/trunk",
    });
    // No PR, no upstream: origin/main, as main's local owner review did.
    expect(
      await inspectCheckout(checkout, query, { recordedBase: false })
    ).toMatchObject({ baseRef: "origin/main" });
    expect(await inspectAgentCheckout(agent() as never, query)).toMatchObject({
      baseRef: "origin/main",
    });
  });
});

describe.each([
  ["in process", inspectCheckout],
  ["CLI", subprocess],
] as const)("checkout inspection %s", (name, inspect) => {
  it("discovers ignored configuration and handles non-Git folders", async () => {
    put(checkout, ".gitignore", ".config/\n");
    put(checkout, ".config/profile.txt", "checkout profile");
    git(checkout, "check-ignore", ".config/profile.txt");
    expect(await inspect(checkout, { kind: "roots" })).toEqual({
      kind: "roots",
      checkoutRoot: checkout,
      repositoryRoot: repo,
    });
    expect(
      await inspect(checkout, { kind: "listFiles", path: ".config" })
    ).toEqual({
      kind: "listFiles",
      names: ["profile.txt"],
    });
    expect(
      await inspect(checkout, { kind: "readFile", path: ".config/missing.txt" })
    ).toEqual({
      kind: "readFile",
      content: null,
    });
    expect(await inspect(bin, { kind: "roots" })).toEqual({
      kind: "roots",
      checkoutRoot: null,
      repositoryRoot: null,
    });
    expect(await inspect(bin, { kind: "listFiles", path: "missing" })).toEqual({
      kind: "listFiles",
      names: [],
    });
  });

  it("refreshes a base and reports committed, staged, unstaged, deleted, renamed and untracked paths", async () => {
    put(checkout, "committed.txt", "committed");
    git(checkout, "add", "committed.txt");
    git(checkout, "commit", "-m", "feature");
    git(checkout, "mv", "rename source.txt", "rename destination.txt");
    rmSync(path.join(checkout, "deleted.txt"));
    put(checkout, "cancel.txt", "index");
    git(checkout, "add", "cancel.txt");
    put(checkout, "cancel.txt", "original");
    put(checkout, "unstaged.txt", "after");
    put(checkout, "sub/ unicode-齿\n.txt ", "untracked");
    put(checkout, "ignore.me", "ignored");
    expect(
      await inspect(path.join(checkout, "sub"), {
        kind: "changes",
        baseBranch: "main",
      })
    ).toEqual({
      kind: "changes",
      baseRef: "origin/main",
      head: git(checkout, "rev-parse", "HEAD"),
      stateId: expect.stringMatching(/^[0-9a-f]{64}$/),
      files: [
        "cancel.txt",
        "committed.txt",
        "deleted.txt",
        "rename destination.txt",
        "rename source.txt",
        "sub/ unicode-齿\n.txt ",
        "unstaged.txt",
      ],
    });
    expect(git(checkout, "rev-parse", "origin/main")).toBe(
      git(repo, "rev-parse", "main")
    );
  });

  it("tries the PR base, then falls back to the configured upstream if no PR exists", async () => {
    git(repo, "branch", "release");
    git(repo, "branch", "integration");
    git(checkout, "fetch", "origin", "integration");
    git(checkout, "branch", "--set-upstream-to", "origin/integration");
    writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh
cat <<'JSON'
{"number":1,"url":"https://example.invalid/pr/1","title":"Test PR","state":"OPEN","isDraft":false,"headRefName":"feature","baseRefName":"release"}
JSON
`
    );
    const expectBase = async (baseBranch: string | null, baseRef: string) => {
      expect(
        await inspect(checkout, { kind: "changes", baseBranch })
      ).toMatchObject({ baseRef, files: [] });
    };
    await expectBase(null, "origin/release");
    await expectBase("main", "origin/main");
    writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n");
    await expectBase(null, "origin/integration");
  });

  it("uses the active branch's valid recorded base before inference", async () => {
    git(repo, "branch", "-m", "main", "trunk");
    git(checkout, "config", "branch.feature.dispatchReviewBase", "trunk");
    git(checkout, "tag", "feature");
    const result = await inspect(checkout, {
      kind: "changes",
      baseBranch: null,
    });
    expect(result).toMatchObject({ baseRef: "origin/trunk", files: [] });
    git(checkout, "config", "branch.feature.dispatchReviewBase", "trunk.");
    await expect(
      inspect(checkout, { kind: "changes", baseBranch: null })
    ).rejects.toThrow(/origin\/main/);
  });

  it("changes stateId for staged and unstaged edits to the same paths", async () => {
    const query = { kind: "changes", baseBranch: "main" } as const;
    put(checkout, "unstaged.txt", "after");
    const unstaged = await inspect(checkout, query);
    expect(await inspect(checkout, query)).toEqual(unstaged);
    put(checkout, "unstaged.txt", "other");
    const edited = await inspect(checkout, query);
    git(checkout, "add", "unstaged.txt");
    const staged = await inspect(checkout, query);
    put(checkout, "unstaged.txt", "index");
    git(checkout, "add", "unstaged.txt");
    const restaged = await inspect(checkout, query);

    const ids = [unstaged, edited, staged, restaged].map((result) => {
      expect(result).toMatchObject({
        files: ["unstaged.txt"],
        stateId: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      return result.kind === "changes" && "stateId" in result
        ? result.stateId
        : null;
    });
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("fingerprints untracked bytes and symlink targets without reading symlink destinations or FIFOs", async () => {
    const query = { kind: "changes", baseBranch: "main" } as const;
    const target = path.join(fixture, "outside");
    put(fixture, "outside", "before");
    put(checkout, "untracked", "one");
    symlinkSync(target, path.join(checkout, "link"));
    execFileSync("mkfifo", [path.join(checkout, "pipe")]);
    const initial = await inspect(checkout, query);
    put(fixture, "outside", "after");
    expect(await inspect(checkout, query)).toEqual(initial);
    put(checkout, "untracked", "two");
    const edited = await inspect(checkout, query);
    expect(edited).not.toEqual(initial);
    rmSync(path.join(checkout, "link"));
    symlinkSync(target + "-elsewhere", path.join(checkout, "link"));
    const changedLink = await inspect(checkout, query);
    expect(changedLink).toMatchObject({ files: ["link", "untracked"] });
    expect(changedLink).not.toEqual(edited);
  });

  it("reads live, repo-relative regular files and reports missing files", async () => {
    put(checkout, ".agents/owners.json", "  owners 齿\n");
    expect(
      await inspect(path.join(checkout, ".agents"), {
        kind: "readFile",
        path: ".agents/owners.json",
      })
    ).toEqual({
      kind: "readFile",
      content: "  owners 齿\n",
    });
    expect(
      await inspect(checkout, {
        kind: "readFile",
        path: ".agents/missing.json",
      })
    ).toEqual({
      kind: "readFile",
      content: null,
    });
  });

  it("refuses escaping paths, Git metadata and FIFOs", async () => {
    put(fixture, "outside/info", "outside");
    execFileSync("mkfifo", [path.join(checkout, "pipe")]);
    for (const file of [
      "../outside/info",
      path.join(fixture, "outside/info"),
      ".git",
      "pipe",
    ]) {
      await expect(
        inspect(checkout, { kind: "readFile", path: file })
      ).rejects.toThrow();
    }
  });

  it("follows symlinked configuration files and directories, as a plain read does", async () => {
    put(fixture, "outside/info", "outside");
    put(checkout, "config/tools.json", "tools");
    put(checkout, ".agents/real/keeper.md", "keeper");
    symlinkSync(
      path.join(fixture, "outside/info"),
      path.join(checkout, "file-link")
    );
    symlinkSync("config", path.join(checkout, "directory-link"));
    symlinkSync("gone", path.join(checkout, "broken-link"));
    symlinkSync("real", path.join(checkout, ".agents/personas"));
    symlinkSync("keeper.md", path.join(checkout, ".agents/real/alias.md"));
    for (const [file, content] of [
      ["file-link", "outside"],
      ["directory-link/tools.json", "tools"],
      [".agents/personas/keeper.md", "keeper"],
      ["broken-link", null],
    ] as const)
      expect(await inspect(checkout, { kind: "readFile", path: file })).toEqual(
        { kind: "readFile", content }
      );
    expect(
      await inspect(checkout, { kind: "listFiles", path: ".agents/personas" })
    ).toEqual({ kind: "listFiles", names: ["alias.md", "keeper.md"] });
  });

  it("bounds the encoded reply to large Git output only in the CLI", async () => {
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    vi.stubEnv("CHECKOUT_TEST_GIT", realGit);
    vi.stubEnv("CHECKOUT_TEST_NODE", process.execPath);
    writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh
if [ "$1" = ls-files ]; then
  exec "$CHECKOUT_TEST_NODE" -e 'process.stdout.write("x".repeat(5 * 1024 * 1024))'
fi
exec "$CHECKOUT_TEST_GIT" "$@"
`,
      { mode: 0o755 }
    );
    const result = inspect(checkout, { kind: "changes", baseBranch: "main" });
    if (name === "CLI") {
      await expect(result).rejects.toThrow(
        "Checkout inspection reply is too large"
      );
    } else {
      await expect(result).resolves.toMatchObject({ kind: "changes" });
    }
  });

  it("fails clearly when no base resolves", async () => {
    git(repo, "branch", "-m", "main", "trunk");
    await expect(
      inspect(checkout, { kind: "changes", baseBranch: "unknown" })
    ).rejects.toThrow(/origin\/main/);
  });

  it("reads a scratch-session persona without requiring a repository", async () => {
    const path = ".agents/personas/scratch.md";
    put(fixture, path, "Scratch reviewer");
    expect(await inspect(fixture, { kind: "readFile", path })).toEqual({
      kind: "readFile",
      content: "Scratch reviewer",
    });
  });

  it("fails with a Git diagnostic outside a worktree", async () => {
    await expect(
      inspect(fixture, { kind: "changes", baseBranch: "main" })
    ).rejects.toThrow(/not a git repository/);
  });
});

it("returns a large local file in full and bounds the CLI reply", async () => {
  const content = "x".repeat(4 * 1024 * 1024);
  put(checkout, "oversized", content);
  const query = { kind: "readFile", path: "oversized" } as const;
  expect(await inspectCheckout(checkout, query)).toEqual({
    kind: "readFile",
    content,
  });
  await expect(subprocess(checkout, query)).rejects.toThrow(
    "Checkout inspection reply is too large"
  );
});

it("rejects malformed and oversized stdin with stderr and no reply", () => {
  for (const [input, diagnostic] of [
    ["{", /JSON/],
    ['{"kind":"changes"}', /Invalid checkout inspection query/],
    [
      '{"kind":"readFile","path":"file","cwd":"/"}',
      /Invalid checkout inspection query/,
    ],
    [" ".repeat(16 * 1024 + 1), /query is too large/],
  ] as const) {
    const result = runCli(checkout, input);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(diagnostic);
  }
});

/** The local runner's session for a row, with no child: the port in process. */
function localSession(row: {
  id: string;
  worktreePath: string;
  worktreeBranch: string;
  baseBranch: string;
}) {
  return archiveRunner(undefined, { ...row, cwd: repo }, controllerPlacement);
}

async function observeThrough(runner: Runner, id: string) {
  return archiveObservation(
    await runner.call("workspace.observe", { session: sessionFromWire(id) })
  );
}

async function releaseThrough(
  runner: Runner,
  row: { id: string; worktreeBranch: string; baseBranch: string }
) {
  const { removed } = await runner.call("workspace.release", {
    session: sessionFromWire(row.id),
    deleteBranch: row.worktreeBranch !== row.baseBranch,
    originalBranch: row.worktreeBranch,
  });
  return removed ? ("released" as const) : ("retained" as const);
}

describe("native runner checkout release", () => {
  function adapter() {
    const binding = {
      id: "agent/fixture",
      worktreePath: checkout,
      worktreeBranch: "feature",
      baseBranch: "main",
    };
    const runner = localSession(binding);
    return {
      observe: () => observeThrough(runner, binding.id),
      release: (_expectedState: string) => releaseThrough(runner, binding),
    };
  }

  it("removes a clean switched worktree and deletes the pre-existing current branch", async () => {
    git(repo, "branch", "user-owned", "main");
    git(checkout, "switch", "user-owned");
    const runner = adapter();
    const { checkout: observed } = await runner.observe();
    expect(observed).toMatchObject({
      branch: "user-owned",
      unmerged: false,
      uncommittedFiles: [],
    });
    expect(await runner.release(observed!.stateId)).toBe("released");
    expect(existsSync(checkout)).toBe(false);
    expect(git(repo, "branch", "--list", "user-owned")).toBe("");
    expect(await runner.release(observed!.stateId)).toBe("released");
  });

  it("removes the owned branch when it is still checked out", async () => {
    const runner = adapter();
    const { checkout: observed } = await runner.observe();
    expect(observed?.branch).toBe("feature");
    expect(await runner.release(observed!.stateId)).toBe("released");
    expect(existsSync(checkout)).toBe(false);
    expect(git(repo, "branch", "--list", "feature")).toBe("");
  });

  it.each([
    [
      "an untracked nested repository",
      () => {
        put(checkout, "nested/inner.txt", "nested work");
        git(path.join(checkout, "nested"), "init", "-q");
      },
    ],
    [
      "an untracked file above 16 MiB",
      () => put(checkout, "big.bin", "x".repeat(16 * 1024 * 1024 + 1)),
    ],
    [
      "more than 10,000 dirty files",
      () => {
        for (let i = 0; i <= 10_000; i++) put(checkout, `many/${i}.txt`, "");
      },
    ],
  ])("observes and removes a worktree with %s", async (_name, dirty) => {
    dirty();
    const runner = adapter();
    const { checkout: observed } = await runner.observe();
    expect(observed?.uncommittedFiles.length).toBeGreaterThan(0);
    expect(await runner.release(observed!.stateId)).toBe("released");
    expect(existsSync(checkout)).toBe(false);
    expect(git(repo, "branch", "--list", "feature")).toBe("");
  });

  it("removes a native checkout edited after the runner observed it", async () => {
    put(checkout, "draft.txt", "first version");
    const runner = adapter();
    const { checkout: observed } = await runner.observe();
    expect(observed?.uncommittedFiles).toEqual(["?? draft.txt"]);
    put(checkout, "draft.txt", "second version");
    expect(await runner.release(observed!.stateId)).toBe("released");
    expect(existsSync(checkout)).toBe(false);
    expect(git(repo, "branch", "--list", "feature")).toBe("");
  });
});

describe("archive checkout parity", () => {
  it.each(
    (["auto", "keep", "force"] as const).flatMap((mode) =>
      (["clean", "dirty", "unmerged", "changed"] as const).flatMap((state) =>
        (["local", "runner"] as const).map((placement) => ({
          mode,
          state,
          placement,
        }))
      )
    )
  )(
    "$placement $mode with a $state checkout",
    async ({ mode, state, placement }) => {
      const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger;
      const local = createLocalRunner(path.join(fixture, "hosts"), logger);
      const agent = {
        id: "agent/fixture",
        cwd: repo,
        worktreePath: checkout,
        worktreeBranch: "feature",
        baseBranch: "main",
      };
      if (state !== "clean") put(checkout, "draft.txt", state);
      if (state === "unmerged") {
        git(checkout, "add", "draft.txt");
        git(checkout, "commit", "-m", "Unmerged change");
      }
      const runner = localSession(agent);
      const observation = await observeThrough(runner, agent.id);
      expect(observation.checkout).toBeTruthy();
      let expectedState = state === "changed" ? "1".repeat(64) : null;
      const pool = {
        query: async (sql: string, params: unknown[]) => {
          if (sql.includes("SELECT archive_checkout_state"))
            return { rows: [{ archive_checkout_state: expectedState }] };
          if (sql.includes("SET archive_checkout_state"))
            expectedState = params[1] as string;
          return { rows: [] };
        },
      } as unknown as Pool;
      const shouldRelease =
        mode === "force" || (mode === "auto" && state === "clean");
      if (placement === "local") {
        await cleanupAgentWorktree(
          pool,
          logger,
          local,
          agent,
          mode,
          {},
          runner
        );
      } else {
        const remote = {
          requestSession: async (
            _placement: unknown,
            request: {
              operation:
                | { kind: "observe" }
                | { kind: "release"; expectedState: string | null };
            }
          ) => ({
            value:
              request.operation.kind === "observe"
                ? JSON.stringify(observation)
                : request.operation.expectedState === null
                  ? "retained"
                  : await releaseThrough(runner, agent),
          }),
        } as unknown as RemoteRunnerService;
        expect(
          (
            await releaseRemoteCheckout(
              pool,
              logger,
              { ...agent, cwd: "runner://test/@session" },
              mode,
              remote,
              true
            )
          ).kind
        ).toBe(shouldRelease ? "released" : "kept");
      }
      expect(existsSync(checkout)).toBe(!shouldRelease);
    }
  );
});
