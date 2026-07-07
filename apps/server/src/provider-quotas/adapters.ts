import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  parseClaudeUsageResponse,
  parseCodexUsageResponse,
  unavailableSnapshot,
} from "./parsers.js";
import type {
  ProviderQuotaProvider,
  ProviderQuotaProviderAdapter,
  ProviderQuotaRefreshResult,
  ProviderQuotaSnapshot,
  ProviderQuotaRefreshOptions,
} from "./types.js";

type JsonObject = Record<string, unknown>;

const execFileAsync = promisify(execFile);
const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.201";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function envValue(env: NodeJS.ProcessEnv, names: string[]): string | null {
  for (const name of names) {
    const value = asString(env[name]);
    if (value) return value;
  }
  return null;
}

function tokenFromJson(value: unknown): string | null {
  if (!isObject(value)) return null;
  const direct =
    asString(value.access_token) ??
    asString(value.accessToken) ??
    asString(value.oauth_access_token) ??
    asString(value.claudeAiOauthAccessToken);
  if (direct) return direct;
  for (const key of [
    "tokens",
    "oauth",
    "claudeAiOauth",
    "oauthAccount",
    "auth",
  ]) {
    const nested = tokenFromJson(value[key]);
    if (nested) return nested;
  }
  return null;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function fetchJson(
  url: string,
  headers: Record<string, string>
): Promise<unknown> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Provider returned ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

function result(
  provider: ProviderQuotaProvider,
  snapshots: ProviderQuotaSnapshot[],
  error: string | null = null,
  options?: { persist?: boolean }
): ProviderQuotaRefreshResult {
  const status = snapshots.some((snapshot) => snapshot.status === "ok")
    ? "ok"
    : (snapshots[0]?.status ?? "error");
  return { provider, snapshots, status, error, persist: options?.persist };
}

export function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = asString(env.CODEX_HOME);
  return path.join(codexHome ?? path.join(os.homedir(), ".codex"), "auth.json");
}

export function claudeCredentialPaths(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const explicit = envValue(env, [
    "DISPATCH_CLAUDE_OAUTH_CREDENTIALS",
    "CLAUDE_OAUTH_CREDENTIALS",
  ]);
  if (explicit) return [explicit];

  const claudeConfigDir =
    envValue(env, ["CLAUDE_CONFIG_DIR", "CLAUDE_HOME"]) ??
    path.join(os.homedir(), ".claude");
  return [
    path.join(claudeConfigDir, ".credentials.json"),
    path.join(claudeConfigDir, "oauth.json"),
    path.join(claudeConfigDir, "auth.json"),
    path.join(claudeConfigDir, "credentials.json"),
  ];
}

export function readCodexAuthTokens(authJson: unknown): {
  accessToken: string | null;
  accountId: string | null;
  accountLabel: string | null;
} {
  const root = isObject(authJson) ? authJson : {};
  const tokens = isObject(root.tokens) ? root.tokens : {};
  return {
    accessToken:
      asString(tokens.access_token) ??
      asString(root.access_token) ??
      asString(root.accessToken),
    accountId:
      asString(root.account_id) ??
      asString(root.accountId) ??
      asString(tokens.account_id),
    accountLabel:
      asString(root.account_label) ??
      asString(root.accountLabel) ??
      asString(root.email),
  };
}

export function readClaudeAuthToken(authJson: unknown): string | null {
  return tokenFromJson(authJson);
}

async function readClaudeTokenFromDisk(
  env: NodeJS.ProcessEnv
): Promise<{ token: string | null; source: string | null }> {
  for (const filePath of claudeCredentialPaths(env)) {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    try {
      const token = readClaudeAuthToken(JSON.parse(raw));
      if (token) return { token, source: filePath };
    } catch {
      continue;
    }
  }
  return { token: null, source: null };
}

async function readClaudeTokenFromKeychain(): Promise<{
  token: string | null;
  error: string | null;
}> {
  if (process.platform !== "darwin") {
    return {
      token: null,
      error: "Claude Code keychain is only supported on macOS.",
    };
  }
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-s", CLAUDE_CODE_KEYCHAIN_SERVICE, "-w"],
      {
        timeout: 1500,
        maxBuffer: 16 * 1024,
      }
    );
    const raw = stdout.trim();
    if (!raw)
      return { token: null, error: "Claude Code keychain item was empty." };
    const token = readClaudeAuthToken(JSON.parse(raw));
    return token
      ? { token, error: null }
      : {
          token: null,
          error:
            "Claude Code keychain payload did not include an OAuth access token.",
        };
  } catch (error) {
    return {
      token: null,
      error: `Claude Code keychain read failed or timed out (${normalizeError(error)}).`,
    };
  }
}

export function createCodexQuotaAdapter(
  env: NodeJS.ProcessEnv = process.env
): ProviderQuotaProviderAdapter {
  return {
    provider: "codex",
    async refresh() {
      const fetchedAt = new Date();
      let authRaw: string;
      try {
        authRaw = await readFile(codexAuthPath(env), "utf8");
      } catch {
        const snapshot = unavailableSnapshot({
          provider: "codex",
          source: "chatgpt-wham",
          error: "Codex auth.json was not found.",
          fetchedAt,
        });
        return result("codex", [snapshot], snapshot.error);
      }

      let auth: unknown;
      try {
        auth = JSON.parse(authRaw);
      } catch {
        const snapshot = unavailableSnapshot({
          provider: "codex",
          source: "chatgpt-wham",
          error: "Codex auth.json is not valid JSON.",
          fetchedAt,
        });
        return result("codex", [snapshot], snapshot.error);
      }

      const { accessToken, accountId, accountLabel } =
        readCodexAuthTokens(auth);
      if (!accessToken) {
        const snapshot = unavailableSnapshot({
          provider: "codex",
          source: "chatgpt-wham",
          error: "Codex auth.json does not contain an access token.",
          fetchedAt,
        });
        return result("codex", [snapshot], snapshot.error);
      }

      try {
        const headers: Record<string, string> = {
          authorization: `Bearer ${accessToken}`,
        };
        if (accountId) {
          headers["chatgpt-account-id"] = accountId;
        }
        const payload = await fetchJson(
          "https://chatgpt.com/backend-api/wham/usage",
          headers
        );
        const snapshots = parseCodexUsageResponse(payload, {
          accountId,
          accountLabel,
          fetchedAt,
        });
        if (snapshots.length === 0) {
          const snapshot = unavailableSnapshot({
            provider: "codex",
            source: "chatgpt-wham",
            error: "Codex usage response did not include quota windows.",
            fetchedAt,
          });
          return result("codex", [snapshot], snapshot.error);
        }
        return result("codex", snapshots);
      } catch (error) {
        const snapshot = unavailableSnapshot({
          provider: "codex",
          source: "chatgpt-wham",
          error: normalizeError(error),
          fetchedAt,
        });
        return result("codex", [snapshot], snapshot.error);
      }
    },
  };
}

export function createClaudeQuotaAdapter(
  env: NodeJS.ProcessEnv = process.env
): ProviderQuotaProviderAdapter {
  return {
    provider: "claude",
    async refresh(options?: ProviderQuotaRefreshOptions) {
      const fetchedAt = new Date();
      const interaction = options?.interaction ?? "background";
      const diskToken = await readClaudeTokenFromDisk(env);
      let accessToken = diskToken.token;
      let credentialSource = diskToken.source ? "anthropic-oauth-file" : null;
      let keychainError: string | null = null;
      const allowBackgroundKeychain =
        env.DISPATCH_CLAUDE_BACKGROUND_KEYCHAIN !== "0";
      if (
        !accessToken &&
        (interaction === "manual" || allowBackgroundKeychain)
      ) {
        const keychain = await readClaudeTokenFromKeychain();
        accessToken = keychain.token;
        keychainError = keychain.error;
        credentialSource = keychain.token
          ? "anthropic-oauth-claude-code-keychain"
          : null;
      }

      if (!accessToken) {
        const backgroundSkippedKeychain =
          interaction === "background" && !allowBackgroundKeychain;
        const snapshot = unavailableSnapshot({
          provider: "claude",
          source: "anthropic-oauth",
          error: backgroundSkippedKeychain
            ? "Claude OAuth credentials were not found in local config JSON. Scheduled Claude Code keychain reads are disabled by DISPATCH_CLAUDE_BACKGROUND_KEYCHAIN=0; use manual refresh or enable background reads."
            : (keychainError ??
              "Claude OAuth credentials were not found in local config JSON or Claude Code keychain."),
          fetchedAt,
        });
        return result("claude", [snapshot], snapshot.error, {
          persist: !backgroundSkippedKeychain,
        });
      }

      try {
        const payload = await fetchJson(
          "https://api.anthropic.com/api/oauth/usage",
          {
            authorization: `Bearer ${accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
            "user-agent": CLAUDE_CODE_USER_AGENT,
          }
        );
        const snapshots = parseClaudeUsageResponse(payload, {
          fetchedAt,
          source: credentialSource ?? "anthropic-oauth",
        });
        if (snapshots.length === 0) {
          const snapshot = unavailableSnapshot({
            provider: "claude",
            source: credentialSource ?? "anthropic-oauth",
            error: "Claude usage response did not include quota windows.",
            fetchedAt,
          });
          return result("claude", [snapshot], snapshot.error);
        }
        return result("claude", snapshots);
      } catch (error) {
        const snapshot = unavailableSnapshot({
          provider: "claude",
          source: credentialSource ?? "anthropic-oauth",
          error: normalizeError(error),
          fetchedAt,
        });
        return result("claude", [snapshot], snapshot.error);
      }
    },
  };
}

export function createProviderQuotaAdapters(): ProviderQuotaProviderAdapter[] {
  return [createCodexQuotaAdapter(), createClaudeQuotaAdapter()];
}
