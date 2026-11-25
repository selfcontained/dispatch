import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadCheckoutPersonas } from "../src/personas/loader.js";

// origin/main loader.ts: readdir, sorted matching names, seen before readFile.
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "persona-native-pin-"));
  roots.push(root);
  for (const dir of [".agents/personas", ".dispatch/personas"])
    await mkdir(path.join(root, dir), { recursive: true });
  return root;
}
async function mainLoad(root: string) {
  const warnings: string[] = [];
  const personas = await loadCheckoutPersonas(
    (dir) => readdir(path.join(root, dir)),
    (file) => readFile(path.join(root, file), "utf8"),
    warnings
  );
  return {
    personas,
    warnings: warnings.map((s) => s.replaceAll(root, "<root>")),
  };
}

it("pins exact native warnings, order, shadowing and an outside symlink", async () => {
  const root = await fixture();
  await symlink("missing", path.join(root, ".agents/personas/a.md"));
  await mkdir(path.join(root, ".agents/personas/b.md"));
  await writeFile(
    path.join(root, ".agents/personas/c.md"),
    "---\ntype: invalid\n---\nbad"
  );
  for (const slug of ["a", "b", "c"])
    await writeFile(
      path.join(root, `.dispatch/personas/${slug}.md`),
      "shadowed"
    );
  await writeFile(path.join(root, "outside"), "outside checkout text");
  await symlink(
    path.join(root, "outside"),
    path.join(root, ".agents/personas/d.md")
  );
  expect(await mainLoad(root)).toEqual({
    personas: [
      {
        type: "review",
        slug: "d",
        name: "d",
        description: "",
        body: "outside checkout text",
      },
    ],
    warnings: [
      "Could not load persona .agents/personas/a.md: ENOENT: no such file or directory, open '<root>/.agents/personas/a.md'",
      "Could not load persona .agents/personas/b.md: EISDIR: illegal operation on a directory, read",
      'Could not load persona .agents/personas/c.md: Invalid persona type "invalid" in c. Expected review or task.',
    ],
  });
});

it("lists FIFO names without opening them and blocks the read until a writer appears", async () => {
  const root = await fixture();
  const fifo = path.join(root, ".agents/personas/fifo.md");
  execFileSync("mkfifo", [fifo]);
  expect(await readdir(path.dirname(fifo))).toEqual(["fifo.md"]);
  let settled = false;
  const pending = mainLoad(root).finally(() => {
    settled = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
  } finally {
    await writeFile(fifo, "fifo content");
  }
  expect(await pending).toEqual({
    personas: [
      {
        type: "review",
        slug: "fifo",
        name: "fifo",
        description: "",
        body: "fifo content",
      },
    ],
    warnings: [],
  });
});
