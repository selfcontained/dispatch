function parseVersion(v: string): [number, number, number] {
  const cleaned = v.startsWith("v") ? v.slice(1) : v;
  const parts = cleaned.split(".").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function isVersionNewer(a: string, b: string): boolean {
  const [aMajor, aMinor, aPatch] = parseVersion(a);
  const [bMajor, bMinor, bPatch] = parseVersion(b);
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch > bPatch;
}
