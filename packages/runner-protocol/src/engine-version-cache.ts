/** Process-local version observations, invalidated when an engine changes. */
export const versionCache = new Map<
  string,
  { fingerprint: string; version: string | null }
>();

export let versionCacheGeneration = 0;

export function clearEngineVersionCache(): void {
  versionCacheGeneration += 1;
  versionCache.clear();
}
