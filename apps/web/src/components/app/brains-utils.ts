export function repoBasename(repoRoot: string): string {
  return repoRoot.split("/").filter(Boolean).pop() ?? repoRoot;
}
