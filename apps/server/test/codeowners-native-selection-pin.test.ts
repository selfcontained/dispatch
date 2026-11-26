import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadCodeowners } from "../src/personas/codeowners.js";
import { OWNERS_PATH, LEGACY_OWNERS_PATH } from "../src/personas/paths.js";
const transition = vi.hoisted(() => ({
  removeBeforeRead: null as string | null,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const remove = transition.removeBeforeRead;
      if (remove && args[0] === remove) {
        transition.removeBeforeRead = null;
        await actual.unlink(remove);
      }
      return actual.readFile(...args);
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  transition.removeBeforeRead = null;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "owner-selection-"))
  );
  roots.push(root);
  const primary = path.join(root, OWNERS_PATH),
    legacy = path.join(root, LEGACY_OWNERS_PATH);
  await mkdir(path.dirname(primary), { recursive: true });
  await mkdir(path.dirname(legacy), { recursive: true });
  const config = (name: string) => ({
    version: 1,
    rules: [{ paths: ["src/**"], personas: [name] }],
  });
  const put = (file: string, name: string) =>
    writeFile(file, JSON.stringify(config(name)));
  return { root, primary, legacy, config, put };
}
it("selects primary when both files exist", async () => {
  const f = await fixture();
  await f.put(f.primary, "primary");
  await f.put(f.legacy, "legacy");
  expect(await loadCodeowners(f.root)).toEqual(f.config("primary"));
});
it("selects legacy only when primary access reports ENOENT", async () => {
  const f = await fixture();
  await f.put(f.legacy, "legacy");
  expect(await loadCodeowners(f.root)).toEqual(f.config("legacy"));
});
it("keeps main's message when neither map exists", async () => {
  const f = await fixture();
  await expect(loadCodeowners(f.root)).rejects.toThrow(
    `No ${OWNERS_PATH} found in this workspace. Add ownership rules before launching owner reviews.`
  );
});
it("access accepts a directory; its later EISDIR read does not try legacy", async () => {
  const f = await fixture();
  await mkdir(f.primary);
  await f.put(f.legacy, "legacy");
  await expect(access(f.primary)).resolves.toBeUndefined();
  await expect(loadCodeowners(f.root)).rejects.toMatchObject({
    code: "EISDIR",
    syscall: "read",
  });
});
it.skipIf(process.getuid?.() === 0)(
  "access accepts an unreadable file; its EACCES read does not try legacy",
  async () => {
    const f = await fixture();
    await f.put(f.primary, "primary");
    await f.put(f.legacy, "legacy");
    await chmod(f.primary, 0);
    try {
      await expect(access(f.primary)).resolves.toBeUndefined();
      await expect(loadCodeowners(f.root)).rejects.toMatchObject({
        code: "EACCES",
        path: f.primary,
        syscall: "open",
      });
    } finally {
      await chmod(f.primary, 0o600);
    }
  }
);
it("follows a dangling primary link and selects legacy on ENOENT", async () => {
  const f = await fixture();
  await symlink(path.join(f.root, "missing"), f.primary);
  await f.put(f.legacy, "legacy");
  expect(await loadCodeowners(f.root)).toEqual(f.config("legacy"));
});
it("keeps the native non-ENOENT access error instead of trying legacy", async () => {
  const f = await fixture();
  await rm(path.dirname(f.primary), { recursive: true });
  await writeFile(path.dirname(f.primary), "file");
  await f.put(f.legacy, "legacy");
  await expect(loadCodeowners(f.root)).rejects.toMatchObject({
    code: "ENOTDIR",
    path: f.primary,
    syscall: "access",
    message: `ENOTDIR: not a directory, access '${f.primary}'`,
  });
});
it("does not retry legacy when the primary disappears after successful access", async () => {
  const f = await fixture();
  await f.put(f.primary, "primary");
  await f.put(f.legacy, "legacy");
  transition.removeBeforeRead = f.primary;
  await expect(loadCodeowners(f.root)).rejects.toMatchObject({
    code: "ENOENT",
    path: f.primary,
    syscall: "open",
    message: `ENOENT: no such file or directory, open '${f.primary}'`,
  });
});
