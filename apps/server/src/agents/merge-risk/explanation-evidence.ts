/** Defense in depth for retained and follow-up evidence; never stores the API key. */
export function retainedEvidence(value: unknown, apiKey: string): unknown {
  if (typeof value === "string") {
    let text = value
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        "[redacted private key]"
      )
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
        "[redacted token]"
      )
      .replace(/\b(authorization\s*:\s*bearer\s+)[^\s"'<>]+/gi, "$1[redacted]");
    if (apiKey.length >= 8) text = text.split(apiKey).join("[redacted token]");
    return text;
  }
  if (Array.isArray(value))
    return value.map((v) => retainedEvidence(v, apiKey));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, retainedEvidence(v, apiKey)])
    );
  return value;
}
