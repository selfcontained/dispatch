import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type AppConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  authToken: string;
  mediaRoot: string;
  dispatchBinDir: string;
  codexBin: string;
  claudeBin: string;
};

export function loadConfig(): AppConfig {
  return {
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.DISPATCH_PORT ?? process.env.PORT ?? 6767),
    databaseUrl:
      process.env.DATABASE_URL ?? "postgres://dispatch:dispatch@127.0.0.1:5432/dispatch",
    authToken: process.env.AUTH_TOKEN ?? "dev-token",
    mediaRoot: process.env.MEDIA_ROOT ?? path.join(process.env.HOME ?? "/tmp", ".dispatch", "media"),
    dispatchBinDir: path.resolve(__dirname, "..", "bin"),
    codexBin:
      process.env.DISPATCH_CODEX_BIN ??
      process.env.HOSTESS_CODEX_BIN ??
      process.env.CODEX_BIN ??
      "codex",
    claudeBin:
      process.env.DISPATCH_CLAUDE_BIN ??
      process.env.HOSTESS_CLAUDE_BIN ??
      process.env.CLAUDE_BIN ??
      "claude"
  };
}
