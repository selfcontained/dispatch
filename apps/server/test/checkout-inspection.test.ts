import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
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
  scratch = mkdtempSync(
    path.join(os.tmpdir(), "dispatch-checkout-inspection-")
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

describe.each([
  ["in process", inspectCheckout],
  ["CLI", subprocess],
] as const)("checkout inspection %s", (_name, inspect) => {
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

  it("rejects a dirty checkout above the fingerprint byte budget", async () => {
    put(checkout, "untracked", "x".repeat(16 * 1024 * 1024 + 1));
    await expect(
      inspect(checkout, { kind: "changes", baseBranch: "main" })
    ).rejects.toThrow(/fingerprint limit/);
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

  it("refuses escaping paths, Git metadata, symlinks, FIFOs and oversized files", async () => {
    put(fixture, "outside/info", "outside");
    put(checkout, "oversized", "x".repeat(256 * 1024 + 1));
    symlinkSync(
      path.join(fixture, "outside"),
      path.join(checkout, "directory-link")
    );
    symlinkSync(
      path.join(fixture, "outside/info"),
      path.join(checkout, "file-link")
    );
    execFileSync("mkfifo", [path.join(checkout, "pipe")]);
    for (const file of [
      "../outside/info",
      path.join(fixture, "outside/info"),
      ".git",
      "directory-link/info",
      "file-link",
      "pipe",
      "oversized",
    ]) {
      await expect(
        inspect(checkout, { kind: "readFile", path: file })
      ).rejects.toThrow();
    }
  });

  it("rejects oversized Git output", async () => {
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
    await expect(
      inspect(checkout, { kind: "changes", baseBranch: "main" })
    ).rejects.toThrow(/MAXBUFFER/);
  });

  it("fails clearly when no base resolves", async () => {
    git(repo, "branch", "-m", "main", "trunk");
    await expect(
      inspect(checkout, { kind: "changes", baseBranch: "unknown" })
    ).rejects.toThrow(/origin\/main/);
  });

  it("fails with a Git diagnostic outside a worktree", async () => {
    await expect(
      inspect(fixture, { kind: "changes", baseBranch: "main" })
    ).rejects.toThrow(/not a git repository/);
  });
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
