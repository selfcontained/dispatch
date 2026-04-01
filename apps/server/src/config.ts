import "dotenv/config";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type TlsConfig = {
  cert: Buffer;
  key: Buffer;
};

export type AppConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  authToken: string;
  mediaRoot: string;
  dispatchBinDir: string;
  codexBin: string;
  claudeBin: string;
  opencodeBin: string;
  agentRuntime: "tmux" | "inert";
  tls: TlsConfig | null;
};

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(process.env.HOME ?? "/tmp", p.slice(2)) : p;
}

function loadTls(): TlsConfig | null {
  const certPath = process.env.TLS_CERT;
  const keyPath = process.env.TLS_KEY;
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    throw new Error("Both TLS_CERT and TLS_KEY must be set to enable TLS");
  }
  return {
    cert: readFileSync(expandHome(certPath)),
    key: readFileSync(expandHome(keyPath)),
  };
}

function resolveAgentRuntime(): "tmux" | "inert" {
  const env = process.env.DISPATCH_AGENT_RUNTIME;
  if (env === "tmux") return "tmux";
  if (env === "inert") return "inert";
  if (env) {
    console.warn(`Unknown DISPATCH_AGENT_RUNTIME="${env}", falling back to auto-detection`);
  }
  // No explicit setting — default to tmux if it's available on PATH
  try {
    execSync("which tmux", { stdio: "ignore" });
    return "tmux";
  } catch {
    return "inert";
  }
}

export function loadConfig(): AppConfig {
  return {
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.DISPATCH_PORT ?? process.env.PORT ?? 6767),
    databaseUrl:
      process.env.DATABASE_URL ?? "postgres://dispatch:dispatch@127.0.0.1:5432/dispatch",
    authToken: process.env.AUTH_TOKEN ?? "dev-token",
    mediaRoot: process.env.MEDIA_ROOT ?? path.join(process.env.HOME ?? "/tmp", ".dispatch", "media"),
    dispatchBinDir: path.resolve(__dirname, "..", "..", "..", "bin"),
    codexBin:
      process.env.DISPATCH_CODEX_BIN ??
      process.env.CODEX_BIN ??
      "codex",
    claudeBin:
      process.env.DISPATCH_CLAUDE_BIN ??
      process.env.CLAUDE_BIN ??
      "claude",
    opencodeBin:
      process.env.DISPATCH_OPENCODE_BIN ??
      process.env.OPENCODE_BIN ??
      "opencode",
    agentRuntime: resolveAgentRuntime(),
    tls: loadTls(),
  };
}
