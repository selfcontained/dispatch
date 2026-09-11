import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  HarnessAuthKind,
  HarnessAuthReport,
  HarnessAuthStatus,
} from "@dispatch/shared";

import {
  runCommand,
  type CommandRunner,
} from "../../shared/lib/run-command.js";

export type HarnessAuthBins = {
  claude: string;
  codex: string;
  gemini: string;
  opencode: string;
};

type FileReader = (file: string, encoding: "utf8") => Promise<string>;

function status(
  engineId: HarnessAuthStatus["engineId"],
  kind: HarnessAuthKind,
  label: string,
  detail?: string
): HarnessAuthStatus {
  return { engineId, kind, label, ...(detail ? { detail } : {}) };
}

export function parseCodexAuth(output: string): HarnessAuthStatus {
  if (/chatgpt/i.test(output)) {
    return status("codex", "subscription", "ChatGPT subscription");
  }
  if (/api[ _-]?key/i.test(output)) {
    return status("codex", "api_key", "OpenAI API key");
  }
  if (/not logged in|logged out/i.test(output)) {
    return status("codex", "not_signed_in", "Not signed in");
  }
  return status("codex", "configured", "Codex login configured");
}

export function parseClaudeAuth(output: string): HarnessAuthStatus {
  try {
    const auth = JSON.parse(output) as {
      loggedIn?: boolean;
      authMethod?: string;
      subscriptionType?: string;
    };
    if (auth.loggedIn === false) {
      return status("claude", "not_signed_in", "Not signed in");
    }
    if (/api.?key/i.test(auth.authMethod ?? "")) {
      return status("claude", "api_key", "Anthropic API key");
    }
    if (auth.authMethod === "claude.ai") {
      const tier = auth.subscriptionType?.trim();
      return status(
        "claude",
        "subscription",
        tier ? `Claude ${tier} subscription` : "Claude subscription"
      );
    }
  } catch {}
  if (/not logged in|logged out/i.test(output)) {
    return status("claude", "not_signed_in", "Not signed in");
  }
  return status("claude", "configured", "Claude login configured");
}

export function parseGeminiAuth(selectedType: unknown): HarnessAuthStatus {
  if (typeof selectedType !== "string" || !selectedType.trim()) {
    return status("gemini", "not_signed_in", "Not signed in");
  }
  if (/api.?key|gemini-api|vertex/i.test(selectedType)) {
    return status("gemini", "api_key", "Google API key");
  }
  if (/oauth|google/i.test(selectedType)) {
    return status("gemini", "oauth", "Google account");
  }
  return status("gemini", "configured", "Gemini login configured");
}

async function commandStatus(
  engineId: "claude" | "codex" | "opencode",
  command: string,
  args: string[],
  runner: CommandRunner
): Promise<HarnessAuthStatus> {
  try {
    const result = await runner(command, args, {
      allowedExitCodes: [0, 1],
      timeoutMs: 4_000,
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (engineId === "codex") return parseCodexAuth(output);
    if (engineId === "claude") return parseClaudeAuth(output);
    if (/0 credentials|no credentials|not logged in/i.test(output)) {
      return status("opencode", "not_signed_in", "Not signed in");
    }
    return status("opencode", "configured", "Provider login configured");
  } catch {
    return status(engineId, "unavailable", "Login status unavailable");
  }
}

export async function loadHarnessAuthReport(
  bins: HarnessAuthBins,
  options: {
    runner?: CommandRunner;
    read?: FileReader;
    homeDir?: string;
    now?: Date;
  } = {}
): Promise<HarnessAuthReport> {
  const runner = options.runner ?? runCommand;
  const read = options.read ?? readFile;
  const homeDir = options.homeDir ?? os.homedir();
  const [claude, codex, opencode, gemini] = await Promise.all([
    commandStatus("claude", bins.claude, ["auth", "status"], runner),
    commandStatus("codex", bins.codex, ["login", "status"], runner),
    commandStatus("opencode", bins.opencode, ["auth", "list"], runner),
    read(path.join(homeDir, ".gemini", "settings.json"), "utf8")
      .then((raw) => {
        const parsed = JSON.parse(raw) as {
          security?: { auth?: { selectedType?: unknown } };
        };
        return parseGeminiAuth(parsed.security?.auth?.selectedType);
      })
      .catch(() => status("gemini", "unavailable", "Login status unavailable")),
  ]);
  return {
    checkedAt: (options.now ?? new Date()).toISOString(),
    engines: [claude, codex, gemini, opencode],
  };
}

export function createHarnessAuthReporter(
  bins: HarnessAuthBins,
  ttlMs = 60_000
): () => Promise<HarnessAuthReport> {
  let cached: { expiresAt: number; report: HarnessAuthReport } | null = null;
  return async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.report;
    const report = await loadHarnessAuthReport(bins);
    cached = { expiresAt: Date.now() + ttlMs, report };
    return report;
  };
}
