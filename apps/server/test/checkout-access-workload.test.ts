import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { checkoutWorkload } from "./helpers/checkout-workload.js";
let root: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "checkout-access-")));
  await mkdir(path.join(root, "directory"));
  await writeFile(path.join(root, "file"), "text");
  await writeFile(path.join(root, "unreadable"), "text");
  await chmod(path.join(root, "unreadable"), 0);
  await symlink("file", path.join(root, "link"));
  await symlink("missing", path.join(root, "dangling"));
  await symlink("loop", path.join(root, "loop"));
  execFileSync("mkfifo", [path.join(root, "fifo")]);
});
afterAll(async () => {
  await chmod(path.join(root, "unreadable"), 0o600);
  await rm(root, { recursive: true, force: true });
});
const probe = (file: string) =>
  checkoutWorkload.run(
    "checkout.access",
    { directory: root, request: { path: file } },
    {}
  );
it.each([
  "file",
  "directory",
  "unreadable",
  "link",
  "dangling",
  "missing",
  "fifo",
])("matches native F_OK without opening entries: %s", async (file) => {
  const native = await access(path.join(root, file))
    .then(() => true)
    .catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  expect(await probe(file)).toBe(native);
});
it.each(["file/child", "loop"])(
  "preserves the exact non-ENOENT failure: %s",
  async (file) => {
    const native = await access(path.join(root, file))
      .then(() => null)
      .catch((error) => error as NodeJS.ErrnoException);
    expect(native).not.toBeNull();
    await expect(probe(file)).rejects.toMatchObject({
      code: "failed",
      message: native!.message,
      details: {
        code: native!.code,
        path: native!.path,
        syscall: native!.syscall,
      },
    });
  }
);
it("follows an entry symlink outside the lexical checkout like main", async () => {
  const outside = await mkdtemp(
    path.join(tmpdir(), "checkout-access-outside-")
  );
  try {
    await writeFile(path.join(outside, "file"), "outside");
    await symlink(path.join(outside, "file"), path.join(root, "outside"));
    expect(await probe("outside")).toBe(true);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
it.each(["../escape", "/absolute"])(
  "refuses lexical escape: %s",
  async (file) => {
    await expect(probe(file)).rejects.toMatchObject({
      code: "invalid",
      message: "Expected a repository-relative worktree file path",
    });
  }
);
it("a successful probe does not turn a later missing native read into a retry", async () => {
  await writeFile(path.join(root, "vanishing"), "text");
  expect(await probe("vanishing")).toBe(true);
  await unlink(path.join(root, "vanishing"));
  await expect(
    checkoutWorkload.run(
      "checkout.read",
      {
        directory: root,
        request: {
          path: "vanishing",
          mode: "native",
          encoding: "utf8",
          maxBytes: null,
        },
      },
      {}
    )
  ).rejects.toMatchObject({
    code: "failed",
    details: {
      code: "ENOENT",
      path: path.join(root, "vanishing"),
      syscall: "open",
    },
  });
  expect(await probe("vanishing")).toBe(false);
});
