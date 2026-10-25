import nodeFs from "node:fs";
import path from "node:path";

export type SetupEnv = {
  DATABASE_URL: string;
  DISPATCH_HOST: string;
  DISPATCH_PORT: string;
  DISPATCH_LISTEN_HOSTS?: string;
  DISPATCH_STATE_DIR: string;
  DISPATCH_SERVER_DIR: string;
  DISPATCH_RUNTIME_PATH: string;
  DISPATCH_UPDATE_OWNER: "windows-tray";
};

const KEY_ORDER: (keyof SetupEnv)[] = [
  "DATABASE_URL",
  "DISPATCH_HOST",
  "DISPATCH_PORT",
  "DISPATCH_LISTEN_HOSTS",
  "DISPATCH_STATE_DIR",
  "DISPATCH_SERVER_DIR",
  "DISPATCH_RUNTIME_PATH",
  "DISPATCH_UPDATE_OWNER",
];

export function installDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (env.DISPATCH_SETUP_INSTALL_DIR) return env.DISPATCH_SETUP_INSTALL_DIR;
  if (platform === "win32" && env.LOCALAPPDATA)
    return path.join(env.LOCALAPPDATA, "Dispatch");
  throw new Error(
    "Set DISPATCH_SETUP_INSTALL_DIR to run Windows setup on this platform"
  );
}

export function buildSetupEnv(input: {
  databaseUrl: string;
  port: number;
  listenHosts?: string;
  installDir: string;
}): SetupEnv {
  return {
    DATABASE_URL: input.databaseUrl,
    DISPATCH_HOST: "127.0.0.1",
    DISPATCH_PORT: String(input.port),
    ...(input.listenHosts ? { DISPATCH_LISTEN_HOSTS: input.listenHosts } : {}),
    DISPATCH_STATE_DIR: path.join(input.installDir, "state"),
    DISPATCH_SERVER_DIR: input.installDir,
    DISPATCH_RUNTIME_PATH: path.join(input.installDir, "dispatch.exe"),
    DISPATCH_UPDATE_OWNER: "windows-tray",
  };
}

// Bun's .env loader expands `$NAME` inside every quoting style and turns
// `\n` into a newline inside double quotes; `\$` and single quotes survive
// both Bun and dotenv unchanged.
export function renderEnvFile(env: SetupEnv): string {
  const lines = KEY_ORDER.flatMap((key) => {
    const value = env[key];
    if (value === undefined) return [];
    const escaped = value.replace(/\$/g, "\\$");
    const quoted = /[\s#]/.test(escaped) ? `'${escaped}'` : escaped;
    return [`${key}=${quoted}`];
  });
  return `${lines.join("\n")}\n`;
}

export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    let value = line.slice(separator + 1);
    if (
      value.length >= 2 &&
      ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"')))
    )
      value = value.slice(1, -1);
    result[key] = value.replace(/\\\$/g, "$");
  }
  return result;
}

type EnvFs = Pick<typeof nodeFs, "mkdirSync" | "writeFileSync" | "renameSync">;

export function writeEnvFile(
  dir: string,
  env: SetupEnv,
  fs: EnvFs = nodeFs
): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, ".env.tmp");
  fs.writeFileSync(tmp, renderEnvFile(env), "utf8");
  fs.renameSync(tmp, path.join(dir, ".env"));
}
