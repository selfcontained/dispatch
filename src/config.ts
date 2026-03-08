import "dotenv/config";
import path from "node:path";

export type AppConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  authToken: string;
  mediaRoot: string;
  hostessBinDir: string;
};

export function loadConfig(): AppConfig {
  return {
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 8787),
    databaseUrl:
      process.env.DATABASE_URL ?? "postgres://hostess:hostess@127.0.0.1:5432/hostess",
    authToken: process.env.AUTH_TOKEN ?? "dev-token",
    mediaRoot: process.env.MEDIA_ROOT ?? "/tmp/hostess-media",
    hostessBinDir: process.env.HOSTESS_BIN_DIR ?? path.resolve(process.cwd(), "bin")
  };
}
