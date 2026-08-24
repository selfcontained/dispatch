/**
 * Compares two semver-ish version strings, ignoring a leading `v` and any
 * prerelease/build suffix (`0.36.0-beta.1` compares as `0.36.0`). Returns
 * negative if `a` < `b`, positive if `a` > `b`, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v.replace(/^v/, "").split("-")[0]!.split(".").map(Number);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
