/**
 * Recognizes conventional test locations and filenames across common languages.
 * This is intentionally filename-based: it never inspects file contents or
 * excludes adjacent test data, fixtures, or snapshots on their own.
 */
export function isTestFile(path: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const fileName = normalizedPath.split("/").at(-1) ?? "";

  return (
    /(?:^|\/)(?:__tests?__|tests?|specs?|e2e|cypress|playwright)(?:\/|$)/i.test(
      normalizedPath
    ) ||
    /(?:^|[._-])(?:test|spec)\.[^.]+$/i.test(fileName) ||
    /(?:^test_|_test\.(?:go|py|rb|rs)$)/i.test(fileName) ||
    /(?:Test|Tests|Spec)\.(?:java|kt|kts|php|swift)$/.test(fileName)
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
