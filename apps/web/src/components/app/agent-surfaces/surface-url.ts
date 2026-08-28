/** Mirrors the server-side surface URL allow-list for version-skewed payloads. */
export function isAllowedSurfaceUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return (
      protocol === "http:" || protocol === "https:" || protocol === "mailto:"
    );
  } catch {
    return false;
  }
}
