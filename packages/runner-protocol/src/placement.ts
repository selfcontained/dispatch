export const MANAGED_WORKSPACE = "@session";

/** Wire identities are case-sensitive and are not paths. */
export function isOpaqueId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    /[\x00-\x1f\x7f-\x9f]/u.test(value)
  ) {
    return false;
  }
  try {
    // Reject lone UTF-16 surrogates, which have no UTF-8 representation.
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}
