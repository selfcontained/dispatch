import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RunnerCallError,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import { createLocalCheckoutRunner } from "../src/runners/local.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CHECKOUT_WRITE_BYTES,
  textDigest,
  writeCheckoutFile,
} from "../../../packages/runner/src/workload/agents/checkout-worker.js";

let root: string;
const file = ".agents/personas/x.md";
const write = (data: string, expectedDigest: string | null, at = file) =>
  writeCheckoutFile(
    root,
    { path: at, data, expectedDigest },
    { descriptors: false }
  );
const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(RunnerCallError);
  const { code, message, details } = error as RunnerCallError;
  return { code, message, details };
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "checkout-write-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checkout.write (main's walk)", () => {
  it("creates the directories and a 0644 file, returning the read digest", async () => {
    const result = await write("hello\n", null);
    expect(result).toEqual({ digest: textDigest("hello\n") });
    expect(await readFile(path.join(root, file), "utf8")).toBe("hello\n");
    const umask = process.umask();
    expect((await stat(path.join(root, file))).mode & 0o777).toBe(
      0o644 & ~umask
    );
  });

  it("replaces in place only when the file still matches what was read", async () => {
    await write("first", null);
    const before = await stat(path.join(root, file));
    await write("second", textDigest("first"));
    const after = await stat(path.join(root, file));
    expect(after.ino).toBe(before.ino);
    expect(await readFile(path.join(root, file), "utf8")).toBe("second");
    expect((await refusal(write("third", textDigest("first")))).code).toBe(
      "stale"
    );
    expect((await refusal(write("third", null))).code).toBe("stale");
    expect(await readFile(path.join(root, file), "utf8")).toBe("second");
  });

  it("never creates a file it was told to find", async () => {
    expect((await refusal(write("x", textDigest("gone")))).code).toBe("stale");
    await expect(stat(path.join(root, file))).rejects.toThrow();
  });

  it("refuses links with structured reasons", async () => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "elsewhere-"));
    try {
      await mkdir(path.join(root, ".agents"));
      await symlink(elsewhere, path.join(root, ".agents/personas"));
      expect(await refusal(write("x", null))).toEqual({
        code: "forbidden",
        message: "Refusing to write through symlinked directory: personas.",
        details: { reason: "symlink-dir", segment: "personas" },
      });
      await rm(path.join(root, ".agents/personas"));
      await mkdir(path.join(root, ".agents/personas"));
      await symlink(path.join(elsewhere, "target.md"), path.join(root, file));
      expect(await refusal(write("x", null))).toEqual({
        code: "forbidden",
        message: "Refusing to overwrite a symlinked file.",
        details: { reason: "symlink-file" },
      });
      await expect(stat(path.join(elsewhere, "target.md"))).rejects.toThrow();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("takes only checkout-relative paths", async () => {
    for (const at of ["../x.md", "/tmp/x.md", "a//b.md", "a/./b.md", ""])
      expect((await refusal(write("x", null, at))).details).toEqual({
        reason: "invalid-path",
      });
  });

  it("passes other file system errors through with main's text", async () => {
    await writeFile(path.join(root, ".agents"), "not a directory");
    await expect(write("x", null)).rejects.toThrow(/^ENOTDIR: not a directory/);
  });

  it("bounds the transport far above any persona", async () => {
    expect(
      (await refusal(write("x".repeat(MAX_CHECKOUT_WRITE_BYTES + 1), null)))
        .details
    ).toEqual({ reason: "too_large" });
  });
});

describe("checkout.write through the local adapter", () => {
  it("writes in process in the agent's workspace when no child holds it", async () => {
    const agent = {
      id: "agent",
      cwd: root,
      worktreePath: null,
      workspacePath: null,
      placement: { runner: "local" },
    } as never;
    const runner = createLocalCheckoutRunner(agent, {} as never);
    await expect(
      runner.call("checkout.write", {
        target: { session: sessionFromWire("agent"), checkout: "current" },
        path: file,
        data: "local",
        expectedDigest: null,
      })
    ).resolves.toEqual({ digest: textDigest("local") });
    expect(await readFile(path.join(root, file), "utf8")).toBe("local");
  });
});
