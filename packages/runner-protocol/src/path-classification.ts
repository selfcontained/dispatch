/**
 * Server-only. The web client never imports these rules: `getAgentDiff` stamps
 * `isTest` on every `DiffFile` and `getDiffStats` applies the same predicate to
 * build the excluding-tests totals, so the Changes tab and the badges both act
 * on a classification the server already made. That is what keeps the file list
 * and the +/- counts from disagreeing about whether a file is a test.
 */

/**
 * Extensions a test can be written in — source languages plus Gherkin. The
 * filename conventions below (`foo.test.x`, `test_foo.x`, `FooSpec.x`) only
 * mean "test" for these; data and prose that happen to be named `api-spec.md`
 * or `test_fixtures.json` are content, not tests, and stay visible. Test data
 * that really does belong to a suite is still hidden by the directory rule.
 */
const CODE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|coffee|vue|svelte|py|rb|go|rs|java|kt|kts|scala|swift|m|mm|ml|mli|php|cs|fs|c|cc|cpp|cxx|h|hh|hpp|ex|exs|erl|elm|dart|lua|jl|nim|zig|hs|lhs|sh|bash|zsh|pl|pm|r|clj|cljs|groovy|feature)$/i;

const TEST_DIRECTORY =
  /(?:^|\/)(?:__tests?__|tests?|specs?|e2e|cypress|playwright)(?:\/|$)/i;

/**
 * Recognizes conventional test locations and filenames across common languages.
 * This is intentionally filename-based: it never inspects file contents or
 * excludes adjacent test data, fixtures, or snapshots on their own.
 */
export function isTestFile(path: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const fileName = normalizedPath.split("/").at(-1) ?? "";

  if (TEST_DIRECTORY.test(normalizedPath)) return true;
  if (!CODE_EXTENSION.test(fileName)) return false;

  return (
    /(?:^|[._-])(?:test|spec)\.[^.]+$/i.test(fileName) ||
    /^test_/i.test(fileName) ||
    /_test\.(?:go|py|rb|rs)$/i.test(fileName) ||
    /(?:Test|Tests|Spec)\.(?:java|kt|kts|php|swift|hs)$/.test(fileName)
  );
}

/**
 * The same rule as `exclude` patterns for a runner's `checkout.stats` and
 * `checkout.diff`: regular-expression literals over the checkout-relative
 * path, any match excluded. Separators are `/` or `\`, as `isTestFile`
 * normalises them; a test checks the two agree.
 */
const SEP = String.raw`[\\/]`;
const NOT_SEP = String.raw`[^\\/]`;
const CODE = CODE_EXTENSION.source.replace(/\$$/, "");
export const TEST_FILE_PATTERNS: readonly string[] = [
  new RegExp(TEST_DIRECTORY.source.replaceAll(String.raw`\/`, SEP), "i"),
  new RegExp(
    String.raw`^(?=.*${CODE}$).*(?:^|[\\/._-])(?:test|spec)\.[^.\\/]+$`,
    "i"
  ),
  new RegExp(String.raw`^(?=.*${CODE}$)(?:.*${SEP})?test_${NOT_SEP}*$`, "i"),
  /_test\.(?:go|py|rb|rs)$/i,
  /(?:Test|Tests|Spec)\.(?:java|kt|kts|php|swift|hs)$/,
].map(String);

const EXCLUDED_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Podfile.lock",
  "Package.resolved",
  "composer.lock",
  "mix.lock",
]);

export function shouldExcludePath(filePath: string): boolean {
  return EXCLUDED_BASENAMES.has(
    filePath.replace(/\/+$/, "").split("/").at(-1) ?? ""
  );
}
