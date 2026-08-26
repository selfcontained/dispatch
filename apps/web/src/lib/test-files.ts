/**
 * Recognizes conventional test locations and filenames across common languages.
 * This is intentionally filename-based: it never inspects file contents or
 * excludes adjacent test data, fixtures, or snapshots on their own.
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

/** Excludes recognized tests unless a direct navigation explicitly targets one. */
export function excludeTestFiles<T extends { path: string }>(
  files: T[],
  preservePath: string | null
): T[] {
  return files.filter(
    (file) => file.path === preservePath || !isTestFile(file.path)
  );
}
