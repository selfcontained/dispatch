const SERVER_ONLY_KEYS = new Set([
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "AZURE_OPENAI_API_KEY",
]);

/**
 * Filter inherited server configuration before spawning a child. Callers can
 * add values they explicitly own after filtering, such as repo agent IDs.
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function childProcessEnv(base = process.env) {
  return Object.fromEntries(
    Object.entries(base).filter(
      ([key, value]) =>
        value !== undefined &&
        !SERVER_ONLY_KEYS.has(key) &&
        !key.startsWith("PG") &&
        !key.startsWith("TLS_") &&
        (!key.startsWith("DISPATCH_") ||
          /^DISPATCH_OWNED_[a-f0-9]{32}$/.test(key))
    )
  );
}
