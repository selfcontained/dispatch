import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { proveMove } from "./runner-move-proof.mjs";

test("attests equal blobs and specifier-only edits, and rejects changes to code or ordinary strings", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "runner-move-proof-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const from = "apps/server/src/a.ts";
  const to = "packages/runner/src/workload/a.ts";
  const old =
    'import { a } from "./a.js";\nexport { b } from "./b.js";\nexport const name = "./a.js";\n';
  const next = old
    .replace('from "./a.js"', 'from "./new-a.js"')
    .replace('from "./b.js"', 'from "./new-b.js"');
  const manifest = {
    [from]: to,
    "apps/server/src/b.ts": "packages/runner/src/workload/b.ts",
  };
  function commit(message) {
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      message
    );
    return git("rev-parse", "HEAD");
  }
  try {
    git("init", "-q");
    mkdirSync(path.join(dir, path.dirname(from)), { recursive: true });
    writeFileSync(path.join(dir, from), old);
    writeFileSync(
      path.join(dir, "apps/server/src/b.ts"),
      "export const b = 1;\n"
    );
    const base = commit("source");
    mkdirSync(path.join(dir, path.dirname(to)), { recursive: true });
    for (const [src, dst] of Object.entries(manifest))
      renameSync(path.join(dir, src), path.join(dir, dst));
    writeFileSync(path.join(dir, to), next);
    const head = commit("relocate");
    const proof = proveMove(base, head, manifest, dir);
    assert.equal(proof.files.length, 2);
    assert.equal(proof.files[0].before, git("rev-parse", base + ":" + from));
    assert.equal(proof.files[0].after, git("rev-parse", head + ":" + to));
    assert.match(proof.files[0].diff, /\+import \{ a \} from "\.\/new-a\.js"/);
    assert.equal(proof.files[1].before, proof.files[1].after);
    assert.equal(proof.files[1].diff, undefined);
    assert.throws(
      () =>
        proveMove(
          base,
          head,
          { [from]: "packages/runner/src/missing.ts" },
          dir
        ),
      /Invalid move pair/
    );
    for (const changed of [
      next.replace('name = "./a.js"', 'name = "./new-a.js"'),
      next.replace("{ a }", "{ c }"),
      next + "// unrelated\n",
    ]) {
      writeFileSync(path.join(dir, to), changed);
      assert.throws(
        () => proveMove(base, commit("unexpected change"), manifest, dir),
        /outside import\/export/
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
