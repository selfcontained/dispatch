/**
 * Diff hunks for an explanation, read at click time through the agent's
 * runner (`github.pr.diff`) and pinned to the assessed head, so later pushes
 * never change what is explained. Never stored. Any failure yields null and
 * the explanation proceeds without hunks.
 */
import { shouldExcludePath } from "@dispatch/runner-protocol";
import { isTestFile } from "@dispatch/runner-protocol";

/** JSON bytes of selected patches; keeps the whole input under its bound. */
export const EXPLANATION_DIFF_BUDGET = 24 * 1024;
const PER_FILE = 4 * 1024;

export type ChangedFile = {
  path: string;
  additions: number;
  deletions: number;
  patch?: string;
};
export type ExplanationDiff = {
  base: string;
  /** Selected hunks, most relevant files first; a file may be partial. */
  files: { path: string; patch: string; truncated?: true }[];
  /** Changed files with no hunks included (budget, skipped or too large). */
  omitted_files: number;
};

const GENERATED =
  /(^|\/)(dist|build|vendor|node_modules|__snapshots__)\/|\.(min\.(js|css)|map|snap|lock|svg|png|jpe?g|gif|ico|woff2?)$/i;
const MIGRATION = /(^|\/)migrations?\//;
/** Files whose contents are likely credentials: never sent, only listed. */
const SECRET =
  /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*(credential|secret)s?[^/]*)$|\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|kdbx|tfvars|tfstate)$/i;
const DOCS = /\.(md|mdx|rst|txt)$/i;

/** Lower is more relevant. Null means never worth budget. */
function tier(path: string): number | null {
  if (shouldExcludePath(path) || GENERATED.test(path) || SECRET.test(path))
    return null;
  if (MIGRATION.test(path)) return 0;
  if (isTestFile(path)) return 2;
  if (DOCS.test(path)) return 3;
  return 1;
}

const bytes = (s: string) => Buffer.byteLength(JSON.stringify(s), "utf8");

/** Keep whole hunks in order up to `max` JSON bytes; clip a lone first hunk. */
function clipPatch(patch: string, max: number) {
  if (bytes(patch) <= max) return { patch };
  const hunks = patch.split(/\n(?=@@ )/);
  let kept = "";
  for (const hunk of hunks) {
    const next = kept ? `${kept}\n${hunk}` : hunk;
    if (bytes(next) > max) break;
    kept = next;
  }
  if (!kept) {
    // One oversized hunk: cut by lines so the model still sees its start.
    for (const line of hunks[0]!.split("\n")) {
      const next = kept ? `${kept}\n${line}` : line;
      if (bytes(next) > max) break;
      kept = next;
    }
  }
  return { patch: kept, truncated: true as const };
}

/**
 * Pick the hunks a reviewer would read first: migrations and source before
 * tests and docs; within a tier, files mentioned in review findings, then the
 * largest changes. Lockfiles, generated and binary files never take budget.
 */
export function selectHunks(
  files: ChangedFile[],
  mentioned: string,
  budget = EXPLANATION_DIFF_BUDGET
): Omit<ExplanationDiff, "base"> {
  const named = (path: string) => {
    const base = path.split("/").pop() ?? path;
    return (
      mentioned.includes(path) || (base.length > 3 && mentioned.includes(base))
    );
  };
  const ranked = files
    .map((file) => ({ file, tier: tier(file.path), named: named(file.path) }))
    .filter((f) => f.tier !== null && f.file.patch)
    .sort(
      (a, b) =>
        a.tier! - b.tier! ||
        Number(b.named) - Number(a.named) ||
        b.file.additions +
          b.file.deletions -
          (a.file.additions + a.file.deletions) ||
        a.file.path.localeCompare(b.file.path)
    );
  const selected: ExplanationDiff["files"] = [];
  let left = budget;
  for (const { file } of ranked) {
    const overhead = bytes(file.path) + 40;
    const room = Math.min(PER_FILE, left - overhead);
    if (room < 256) break;
    const clipped = clipPatch(file.patch!, room);
    if (!clipped.patch) continue;
    selected.push({ path: file.path, ...clipped });
    left -= bytes(clipped.patch) + overhead;
  }
  return { files: selected, omitted_files: files.length - selected.length };
}

/** Text of review findings, used only to rank files they mention. */
export function mentionedText(evidence: unknown): string {
  const reviews = (evidence as { reviews?: unknown } | null)?.reviews;
  if (!Array.isArray(reviews)) return "";
  return reviews
    .flatMap((r) =>
      Array.isArray((r as { findings?: unknown }).findings)
        ? (r as { findings: Record<string, unknown>[] }).findings.map(
            (f) => `${f.title ?? ""} ${f.note ?? ""}`
          )
        : []
    )
    .join("\n");
}
