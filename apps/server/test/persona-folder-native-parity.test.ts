import { execFileSync } from "node:child_process";
import {
  chmod,
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
import { checkoutWorkload } from "./helpers/checkout-workload.js";
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

it.each([mainLoad, runnerLoad])(
  "pins exact native warnings, order, shadowing and an outside symlink (%#)",
  async (load) => {
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
    const external = await mkdtemp(path.join(tmpdir(), "persona-external-"));
    roots.push(external);
    await writeFile(path.join(external, "outside"), "outside checkout text");
    await symlink(
      path.join(external, "outside"),
      path.join(root, ".agents/personas/d.md")
    );
    expect(await load(root)).toEqual({
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
  }
);

it.each([mainLoad, runnerLoad])(
  "lists FIFO names without opening them and blocks the read until a writer appears (%#)",
  async (load) => {
    const root = await fixture();
    const fifo = path.join(root, ".agents/personas/fifo.md");
    execFileSync("mkfifo", [fifo]);
    expect(await readdir(path.dirname(fifo))).toEqual(["fifo.md"]);
    let settled = false;
    const pending = load(root).finally(() => {
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
  }
);

async function runnerLoad(root: string) {
  const warnings: string[] = [];
  const personas = await loadCheckoutPersonas(
    async (dir) => {
      const reply = await checkoutWorkload.run(
        "checkout.list",
        { directory: root, request: { path: dir, mode: "native" } },
        {}
      );
      return reply.names!;
    },
    async (file) => {
      const reply = await checkoutWorkload.run(
        "checkout.read",
        {
          directory: root,
          request: {
            path: file,
            mode: "native",
            encoding: "utf8",
            maxBytes: null,
          },
        },
        {}
      );
      return reply?.data ?? null;
    },
    warnings
  );
  return {
    personas,
    warnings: warnings.map((s) => s.replaceAll(root, "<root>")),
  };
}

it.each(["../escape", "/absolute", "x/../../escape"])(
  "refuses native requests outside the target: %s",
  async (file) => {
    const root = await fixture();
    for (const op of ["checkout.list", "checkout.read"] as const)
      await expect(
        checkoutWorkload.run(
          op,
          {
            directory: root,
            request: {
              path: file,
              mode: "native",
              encoding: "utf8",
              maxBytes: null,
            },
          } as never,
          {}
        )
      ).rejects.toMatchObject({ code: "invalid" });
  }
);

it.each([mainLoad, runnerLoad])(
  "pins unreadable errors and uncapped empty/large files (%#)",
  async (load) => {
    const root = await fixture();
    const denied = path.join(root, ".agents/personas/denied.md");
    await writeFile(denied, "secret");
    await chmod(denied, 0);
    await writeFile(path.join(root, ".agents/personas/empty.md"), "");
    const large = "x".repeat(5 * 1024 * 1024);
    await writeFile(path.join(root, ".agents/personas/large.md"), large);
    const result = await load(root);
    expect(result.personas.map((p) => [p.slug, p.body])).toEqual([
      ["empty", ""],
      ["large", large],
    ]);
    expect(result.warnings).toEqual([
      "Could not load persona .agents/personas/denied.md: EACCES: permission denied, open '<root>/.agents/personas/denied.md'",
    ]);
  }
);
