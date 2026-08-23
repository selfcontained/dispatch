import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WORKTREE_LOCAL_CONFIG_FILES,
  assertTopLevelFileName,
  copyLocalConfigFiles,
} from "../src/agents/worktree-local-config.js";

let tempRoot: string;
let sourceRoot: string;
let worktreePath: string;
let outside: string;

beforeEach(async () => {
  // A path with a space and an apostrophe — the same string is shell-quoted
  // into the tmux setup script, so it must survive both launch paths.
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "local-config-test-"));
  sourceRoot = path.join(tempRoot, "it's a repo");
  worktreePath = path.join(tempRoot, "wt");
  outside = path.join(tempRoot, "outside");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const src = (name: string) => path.join(sourceRoot, name);
const dest = (name: string) => path.join(worktreePath, name);
const writeSource = (name: string, contents = "x\n") =>
  writeFile(src(name), contents);

describe("WORKTREE_LOCAL_CONFIG_FILES", () => {
  it("keeps .env and stays clear of the names deliberately rejected", () => {
    expect(WORKTREE_LOCAL_CONFIG_FILES).toContain(".env");
    // Copying .envrc fixes nothing until direnv approves the new worktree,
    // and a permission allowlist would widen what a restricted launch can do.
    expect(WORKTREE_LOCAL_CONFIG_FILES).not.toContain(".envrc");
    expect(WORKTREE_LOCAL_CONFIG_FILES).not.toContain(
      ".claude/settings.local.json"
    );
  });
});

describe("assertTopLevelFileName", () => {
  it("accepts every name the module ships", () => {
    for (const name of WORKTREE_LOCAL_CONFIG_FILES) {
      expect(assertTopLevelFileName(name)).toBe(name);
    }
  });

  it.each([
    // Anything bash would expand but `fs` would look up literally (or the
    // reverse) is how the two launch paths drift apart.
    ".env.*.local",
    "*.auto.tfvars",
    "config/master.key",
    "config/",
    "/etc/passwd",
    "../outside/.env",
    "",
    ".",
    "..",
    ".env;rm -rf /",
    ".env$(id)",
    ".env with space",
  ])("rejects %j", (name) => {
    expect(() => assertTopLevelFileName(name)).toThrow(
      /Unsafe worktree local-config filename/
    );
  });
});

describe("copyLocalConfigFiles", () => {
  it("copies the listed files that exist, at 0600, and nothing else", async () => {
    await writeSource(".env", "FOO=bar\n");
    await writeSource(".dev.vars", "CF=1\n");
    await chmod(src(".env"), 0o644);
    // Committed neighbours are already in the worktree via the checkout,
    // and a directory sharing a listed name is not a config file.
    for (const name of [".env.example", ".env.sample", ".env.production"]) {
      await writeSource(name);
    }
    await mkdir(src("terraform.tfvars"));

    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([".env", ".dev.vars"]);
    await expect(readFile(dest(".dev.vars"), "utf-8")).resolves.toBe("CF=1\n");
    expect((await stat(dest(".env"))).mode & 0o777).toBe(0o600);
  });

  it("leaves every kind of existing destination untouched", async () => {
    // One listed name per destination state. A regular file is what a repo
    // that commits the name produces; the two symlinks are write primitives
    // if followed, and the dangling one is invisible to an existence test.
    await writeSource(".env.local", "FROM_SOURCE\n");
    await writeSource(".env", "FROM_SOURCE\n");
    await writeSource(".dev.vars", "FROM_SOURCE\n");
    const live = path.join(outside, "live");
    await writeFile(live, "ORIGINAL\n");
    await writeFile(dest(".env.local"), "FROM_GIT\n");
    await symlink(live, dest(".env"));
    await symlink(path.join(outside, "dangling"), dest(".dev.vars"));

    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([]);
    await expect(readFile(dest(".env.local"), "utf-8")).resolves.toBe(
      "FROM_GIT\n"
    );
    await expect(readFile(live, "utf-8")).resolves.toBe("ORIGINAL\n");
    await expect(readFile(path.join(outside, "dangling"))).rejects.toThrow();
  });

  it("refuses a symlinked source while still copying its neighbours", async () => {
    // Otherwise a checkout containing `.env -> ~/.ssh/id_rsa` copies that
    // file somewhere the repo can read it. `O_NOFOLLOW` refuses on the same
    // open the copy reads from, so there is no path test to race.
    const secret = path.join(outside, "id_rsa");
    await writeFile(secret, "PRIVATE KEY\n");
    await symlink(secret, src(".env"));
    await writeSource(".dev.vars", "CF=1\n");

    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([".dev.vars"]);
    await expect(readFile(dest(".env"))).rejects.toThrow();
  });

  it("is a no-op with nothing to copy, or nowhere to copy to", async () => {
    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([]);

    await writeSource(".env");
    await expect(
      copyLocalConfigFiles(sourceRoot, path.join(tempRoot, "nope"))
    ).resolves.toEqual([]);
  });
});
