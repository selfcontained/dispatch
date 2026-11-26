// Produce the byte and specifier evidence for the atomic workload move.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const manifestUrl = new URL(
  "./fixtures/runner-workload-move.json",
  import.meta.url
);

/** Keep all text, including comments and whitespace, except the content of module specifiers. */
function maskSpecifiers(path, source) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  if (tree.parseDiagnostics.length) throw new Error(`Cannot parse ${path}`);
  const spans = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const literal = node.moduleSpecifier;
      spans.push([literal.getStart(tree) + 1, literal.getEnd() - 1]);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  let masked = source;
  for (const [start, end] of spans.reverse()) {
    masked = masked.slice(0, start) + "\u0000" + masked.slice(end);
  }
  return masked;
}

export function proveMove(before, after, manifest, cwd = process.cwd()) {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  const commit = (revision) =>
    git(
      "rev-parse",
      "--verify",
      "--end-of-options",
      revision + "^{commit}"
    ).trim();
  const base = commit(before);
  const head = commit(after);
  function tree(revision) {
    return new Map(
      git("ls-tree", "-rz", revision)
        .split("\0")
        .filter(Boolean)
        .map((row) => {
          const tab = row.indexOf("\t");
          const [mode, type, blob] = row.slice(0, tab).split(" ");
          return [row.slice(tab + 1), { mode, type, blob }];
        })
    );
  }
  const original = tree(base);
  const moved = tree(head);
  const pairs = Object.entries(manifest);
  if (!pairs.length || new Set(Object.values(manifest)).size !== pairs.length)
    throw new Error("Expected unique move destinations");
  const files = pairs.map(([from, to]) => {
    const a = original.get(from);
    const b = moved.get(to);
    if (
      !from.startsWith("apps/server/src/") ||
      !to.startsWith("packages/runner/src/") ||
      !a ||
      !b ||
      original.has(to) ||
      moved.has(from) ||
      a.type !== "blob" ||
      b.type !== "blob" ||
      a.mode !== "100644" ||
      b.mode !== a.mode
    )
      throw new Error(`Invalid move pair: ${from} -> ${to}`);
    const row = { from, to, before: a.blob, after: b.blob };
    if (a.blob === b.blob) return row;
    const oldText = git("cat-file", "blob", a.blob);
    const newText = git("cat-file", "blob", b.blob);
    if (maskSpecifiers(from, oldText) !== maskSpecifiers(to, newText))
      throw new Error(
        `Change outside import/export module specifiers: ${from} -> ${to}`
      );
    const diff = git(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--full-index",
      base + ":" + from,
      head + ":" + to
    );
    return { ...row, diff };
  });
  return { base, head, files };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [base, head, ...extra] = process.argv.slice(2);
  if (!base || !head || extra.length)
    throw new Error("Usage: node scripts/runner-move-proof.mjs BASE HEAD");
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
  if (Object.keys(manifest).length !== 67)
    throw new Error("Expected exactly 67 workload files");
  process.stdout.write(
    JSON.stringify(proveMove(base, head, manifest), null, 2) + "\n"
  );
}
