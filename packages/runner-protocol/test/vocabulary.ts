import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/** Dispatch product words that must not name anything in the protocol. */
const WORDS = new Set(
  [
    "persona",
    "review",
    "task",
    "board",
    "brain",
    "chat",
    "job",
    "template",
  ].flatMap((word) => [word, `${word}s`])
);
/** Dispatch names matched anywhere in a string. */
const NAMES = /DISPATCH_|\.dispatch|agt_/i;

/** Dispatch names the contract also may not use (its session handle replaces agent ids). */
const CONTRACT_NAMES = /agent_?id|promptsource|persona|dispatch/i;

/** Whether a contract name or literal uses Dispatch vocabulary. */
export function usesContractVocabulary(text: string): boolean {
  return CONTRACT_NAMES.test(text) || usesDispatchVocabulary(text);
}

/** Whether a name or literal uses Dispatch vocabulary, by whole words. */
export function usesDispatchVocabulary(text: string): boolean {
  if (NAMES.test(text)) return true;
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => WORDS.has(word));
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : []
  );
}

/** Identifiers and string literals (not comments) that use Dispatch vocabulary. */
export function vocabularyHits(
  root: string,
  dir: string,
  uses: (text: string) => boolean = usesDispatchVocabulary,
  allowed: (file: string, token: string) => boolean = () => false
) {
  const hits: string[] = [];
  for (const file of files(dir)) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    const visit = (node: ts.Node) => {
      const text =
        ts.isIdentifier(node) || ts.isPrivateIdentifier(node)
          ? node.text
          : ts.isStringLiteralLike(node)
            ? node.text
            : undefined;
      if (text !== undefined && uses(text) && !allowed(file, text))
        hits.push(`${relative(root, file)}: ${text}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...new Set(hits)].sort();
}
