/*
 * Persona authoring through an agent's checkout (its runner) answers
 * exactly as main's in-process authoring at the same root: the bytes, the
 * mode, the result and every message, for each case main's tool handles.
 * The local agent here has no runner child, so the local adapter runs the
 * same workload in process.
 */
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCheckout } from "./helpers/checkout-inspection.js";
import {
  upsertCheckoutPersona,
  validateCheckoutPersonas,
  type PersonaFiles,
} from "../src/personas/authoring.js";
import {
  upsertPersona,
  validatePersonas,
} from "./helpers/native-persona-authoring.js";
import { sessionPersonaFiles } from "../src/personas/checkout-files.js";
import { controllerPlacement } from "../src/runners/placement.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "persona-parity-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
}

function checkoutFiles(root: string): PersonaFiles {
  const agent = {
    id: "agent",
    cwd: root,
    worktreePath: null,
    workspacePath: null,
    placement: controllerPlacement,
  } as never;
  return sessionPersonaFiles(
    {
      checkoutReadRunners: () => ({}) as never,
      inspectCheckout: (_agent, query) =>
        inspectCheckout(root, query, { recordedBase: false }),
    },
    agent
  ).files;
}

/** Every file under the persona directories, with its bytes and mode. */
async function snapshot(root: string) {
  const out: Record<string, { text: string; mode: number }> = {};
  for (const dir of [".agents/personas", ".dispatch/personas"]) {
    const names = await readdir(path.join(root, dir)).catch(() => []);
    for (const name of names.sort()) {
      const file = path.join(root, dir, name);
      out[`${dir}/${name}`] = {
        text: await readFile(file, "utf8").catch(() => "<unreadable>"),
        mode: (await stat(file).catch(() => ({ mode: 0 }))).mode & 0o777,
      };
    }
  }
  return out;
}

const settle = async <T>(work: () => Promise<T>) => {
  try {
    return { ok: await work() };
  } catch (error) {
    return { error: (error as Error).message };
  }
};

type Setup = (root: string) => Promise<void>;
const input = {
  slug: "builder",
  name: "Builder",
  description: "Builds",
  instructions: "Do the work.\n",
};

const cases: Array<
  [string, Setup, Partial<typeof input> & { type?: "task" | "review" }]
> = [
  ["creates a new persona and its directories", async () => {}, {}],
  [
    "overwrites an existing persona, keeping its type",
    async (root) => {
      await mkdir(path.join(root, ".agents/personas"), { recursive: true });
      await writeFile(
        path.join(root, ".agents/personas/builder.md"),
        "---\ntype: review\nname: Old\ndescription: Old\n---\n\nold\n"
      );
    },
    {},
  ],
  [
    "overwrites with an explicit type",
    async (root) => {
      await mkdir(path.join(root, ".agents/personas"), { recursive: true });
      await writeFile(path.join(root, ".agents/personas/builder.md"), "old");
    },
    { type: "task" },
  ],
  [
    "updates a legacy-only persona where it is",
    async (root) => {
      await mkdir(path.join(root, ".dispatch/personas"), { recursive: true });
      await writeFile(
        path.join(root, ".dispatch/personas/builder.md"),
        "---\nname: Legacy\ndescription: d\n---\nlegacy\n"
      );
    },
    {},
  ],
  [
    "refuses a symlinked persona directory",
    async (root) => {
      const elsewhere = await mkdtemp(path.join(os.tmpdir(), "elsewhere-"));
      roots.push(elsewhere);
      await mkdir(path.join(root, ".agents"));
      await symlink(elsewhere, path.join(root, ".agents/personas"));
    },
    {},
  ],
  [
    "refuses a symlinked persona file",
    async (root) => {
      const elsewhere = await mkdtemp(path.join(os.tmpdir(), "elsewhere-"));
      roots.push(elsewhere);
      await writeFile(path.join(elsewhere, "real.md"), "real");
      await mkdir(path.join(root, ".agents/personas"), { recursive: true });
      await symlink(
        path.join(elsewhere, "real.md"),
        path.join(root, ".agents/personas/builder.md")
      );
    },
    {},
  ],
  ["refuses an invalid slug", async () => {}, { slug: "Bad Slug" }],
  ["refuses a multi-line name", async () => {}, { name: "a\nb" }],
  ["refuses empty instructions", async () => {}, { instructions: "  " }],
];

describe("persona authoring through the checkout matches main", () => {
  it.each(cases)("%s", async (_label, setup, overrides) => {
    const [mainRoot, checkoutRoot] = [await repo(), await repo()];
    await setup(mainRoot);
    await setup(checkoutRoot);
    const request = { ...input, ...overrides };
    const viaMain = await settle(() =>
      upsertPersona({ root: mainRoot, ...request })
    );
    const viaCheckout = await settle(() =>
      upsertCheckoutPersona(checkoutFiles(checkoutRoot), request)
    );
    expect(viaCheckout).toEqual(viaMain);
    expect(await snapshot(checkoutRoot)).toEqual(await snapshot(mainRoot));
  });

  it("validates what main validates", async () => {
    const [mainRoot, checkoutRoot] = [await repo(), await repo()];
    for (const root of [mainRoot, checkoutRoot]) {
      await mkdir(path.join(root, ".agents/personas"), { recursive: true });
      await mkdir(path.join(root, ".dispatch/personas"), { recursive: true });
      await writeFile(
        path.join(root, ".agents/personas/good.md"),
        "---\nname: G\ndescription: d\n---\nbody"
      );
      await writeFile(
        path.join(root, ".agents/personas/Bad.md"),
        "---\ntype: other\n---\n"
      );
      await writeFile(
        path.join(root, ".dispatch/personas/good.md"),
        "---\nname: G\ndescription: d\n---\nold"
      );
      await writeFile(
        path.join(root, ".dispatch/personas/only.md"),
        "---\nname: O\ndescription: d\n---\nonly"
      );
    }
    expect(await validateCheckoutPersonas(checkoutFiles(checkoutRoot))).toEqual(
      await validatePersonas(mainRoot)
    );
  });

  it("re-reads when the file changes underneath, and never overwrites another writer", async () => {
    const root = await repo();
    const files = checkoutFiles(root);
    let writes = 0;
    const racing: PersonaFiles = {
      ...files,
      async write(file, data, digest) {
        writes += 1;
        // Someone else writes between our read and our write, every time.
        await mkdir(path.join(root, ".agents/personas"), { recursive: true });
        await writeFile(path.join(root, file), `other ${writes}`);
        return files.write(file, data, digest);
      },
    };
    await expect(upsertCheckoutPersona(racing, input)).rejects.toThrow(
      ".agents/personas/builder.md kept changing while it was being written. Nothing was overwritten; try again."
    );
    expect(writes).toBe(3);
    expect(
      await readFile(path.join(root, ".agents/personas/builder.md"), "utf8")
    ).toBe("other 3");

    // One change underneath: the second attempt reads it and succeeds.
    let raced = false;
    const once: PersonaFiles = {
      ...files,
      async write(file, data, digest) {
        if (!raced) {
          raced = true;
          await writeFile(
            path.join(root, file),
            "---\ntype: review\nname: X\ndescription: Y\n---\nz"
          );
        }
        return files.write(file, data, digest);
      },
    };
    const result = await upsertCheckoutPersona(once, input);
    expect(result.created).toBe(false);
    expect(result.content).toContain("type: review");
  });
});
