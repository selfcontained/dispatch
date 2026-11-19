export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isHttpUrl(value: unknown, allowHttp = false): value is string {
  if (typeof value !== "string" || /[\x00-\x20\x7f-\x9f]/u.test(value))
    return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (allowHttp && url.protocol === "http:");
  } catch {
    return false;
  }
}
