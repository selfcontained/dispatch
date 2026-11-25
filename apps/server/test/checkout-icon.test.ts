/*
 * The icon scan reads a checkout through the runner's `checkout.list` and
 * `checkout.read`; its answer must match the host-filesystem scan, and the
 * raw bytes read must stay inside the checkout.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runner } from "@dispatch/runner-protocol/contract";
import { checkoutWorkload } from "./helpers/checkout-workload.js";
import {
  detectAgentIcon,
  iconTarget,
  readAgentIcon,
} from "../src/agents/checkout-icon.js";
import { sessionRunner } from "../src/agents/checkout-runner.js";
import { controllerPlacement } from "../src/runners/placement.js";
import { detectRepoIcon } from "../src/shared/repo-icon.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "checkout-icon-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const runner = (root: string) =>
  ({
    call: (op: string, request: { target: unknown }) => {
      const { target: _, ...rest } = request;
      return checkoutWorkload.run(
        op as never,
        {
          directory: root,
          request: rest,
        } as never
      );
    },
  }) as unknown as Runner;
const agent = { id: "agt_icon" };
const at = (_root: string) => iconTarget(agent);
const put = async (rel: string, data: string | Buffer = "x") => {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), data);
};

describe("agent icon through the runner", () => {
  it("finds what the host scan finds", async () => {
    const layouts: string[][] = [
      [],
      ["favicon.svg", "favicon.png"],
      ["assets/logo.png", "src/deep/icon.ico", "node_modules/x/logo.svg"],
      [".dispatch/logo.png", "favicon.svg"],
      ["a/b/c/d/e/logo.svg"],
      ["brand.svg", "my-logo-dark.png", "README.md"],
    ];
    for (const files of layouts) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir);
      for (const file of files) await put(file);
      expect(await detectAgentIcon(runner(dir), at(dir))).toBe(
        await detectRepoIcon(dir)
      );
    }
  });

  it("reads raw bytes, with a digest, from inside the checkout only", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128]);
    await put("logo.png", png);
    await put("empty.svg", "");
    expect(await readAgentIcon(runner(dir), at(dir), "logo.png")).toEqual(png);
    const file = await runner(dir).call("checkout.read", {
      target: { session: "s" },
      path: "logo.png",
      encoding: "base64",
      maxBytes: null,
    } as never);
    expect(file).toEqual({
      data: png.toString("base64"),
      digest: createHash("sha256").update(png).digest("hex"),
    });
    expect(await readAgentIcon(runner(dir), at(dir), "empty.svg")).toEqual(
      Buffer.alloc(0)
    );
    expect(await readAgentIcon(runner(dir), at(dir), "missing.png")).toBeNull();

    const outside = await mkdtemp(path.join(tmpdir(), "checkout-icon-out-"));
    try {
      await writeFile(path.join(outside, "secret.png"), "secret");
      await symlink(
        path.join(outside, "secret.png"),
        path.join(dir, "out.png")
      );
      await mkdir(path.join(dir, "inner"));
      await symlink(path.join(dir, "logo.png"), path.join(dir, "inner/in.png"));
      expect(await readAgentIcon(runner(dir), at(dir), "out.png")).toBe(
        "outside"
      );
      expect(await readAgentIcon(runner(dir), at(dir), "../x.png")).toBeNull();
      expect(await readAgentIcon(runner(dir), at(dir), "inner")).toBeNull();
      expect(await readAgentIcon(runner(dir), at(dir), "inner/in.png")).toEqual(
        png
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a file over the limit before reading it", async () => {
    await put("logo.png", "12345");
    await expect(
      runner(dir).call("checkout.read", {
        target: { session: "s" },
        path: "logo.png",
        encoding: "base64",
        maxBytes: 4,
      } as never)
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("treats a runner that cannot answer as no icon", async () => {
    const broken = {
      call: async () => {
        throw new Error("offline");
      },
    } as unknown as Runner;
    expect(await detectAgentIcon(broken, at(dir))).toBeNull();
    expect(await readAgentIcon(broken, at(dir), "logo.png")).toBeNull();
  });

  it("finds a Git-ignored icon and counts every entry, as the host scan does", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await put(".gitignore", "assets/\n");
    await put("assets/logo.svg");
    expect(await detectRepoIcon(dir)).toBe(path.join("assets", "logo.svg"));
    expect(await detectAgentIcon(runner(dir), at(dir))).toBe(
      path.join("assets", "logo.svg")
    );
    // 199 files and `.git` make 200 entries beside the icon: over the limit.
    await rm(path.join(dir, "assets"), { recursive: true });
    await put("favicon.svg");
    for (let i = 0; i < 197; i++) await put(`f${i}.txt`);
    const host = await detectRepoIcon(dir);
    expect(await detectAgentIcon(runner(dir), at(dir))).toBe(host);
    await put("extra.txt");
    expect(await detectRepoIcon(dir)).toBeNull();
    expect(await detectAgentIcon(runner(dir), at(dir))).toBeNull();
  });

  it("reads a worktree agent's icon from the folder it was launched in", async () => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await put("README.md");
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@e.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@e.com",
        },
      });
    git("add", ".");
    git("commit", "-qm", "init");
    const worktree = path.join(dir, "..", path.basename(dir) + "-wt");
    git("worktree", "add", "-q", worktree, "-b", "work");
    await put("logo.svg"); // untracked, in the launch folder only
    try {
      const row = {
        id: "agt_wt",
        cwd: worktree,
        worktreePath: worktree,
        workspacePath: null,
        placement: controllerPlacement,
        launchCwd: dir,
      };
      // The route's base directory for this agent, as main computes it.
      const through = sessionRunner({}, row);
      const target = iconTarget(row);
      expect(await detectAgentIcon(through, target)).toBe("logo.svg");
      expect(await readAgentIcon(through, target, "logo.svg")).toEqual(
        Buffer.from("x")
      );
      // Without a recorded launch folder, the repository root is read.
      const noLaunch = {
        ...row,
        launchCwd: null,
        gitContext: { worktreePath: worktree, isWorktree: true, repoRoot: dir },
      };
      expect(
        await detectAgentIcon(sessionRunner({}, noLaunch), iconTarget(noLaunch))
      ).toBe("logo.svg");
      // With neither, the agent's own folder: the worktree holds no icon.
      const plain = { ...row, launchCwd: null, gitContext: null };
      expect(
        await detectAgentIcon(sessionRunner({}, plain), iconTarget(plain))
      ).toBeNull();
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it("reports a file the runner may not open as unreadable", async () => {
    if (process.getuid?.() === 0) return;
    await put("logo.png", "x");
    await chmod(path.join(dir, "logo.png"), 0o000);
    expect(await readAgentIcon(runner(dir), at(dir), "logo.png")).toBe(
      "unreadable"
    );
  });
});
