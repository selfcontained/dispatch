export function normalizeDispatchBaseUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Dispatch URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("Dispatch URL cannot include credentials.");
  }
  return url.origin;
}

export function usesInsecureHttp(input: string): boolean {
  return new URL(input).protocol === "http:";
}
