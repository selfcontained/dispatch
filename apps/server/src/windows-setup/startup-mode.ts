import nodeFs from "node:fs";
import path from "node:path";

import { parseEnvFile } from "./env-file.js";

export type StartupMode = "serve" | "setup";

export function decideStartupMode(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  argv: string[];
}): StartupMode {
  if (input.env.DISPATCH_FORCE_SETUP_MODE === "1") return "setup";
  if (
    input.platform === "win32" &&
    !input.env.DATABASE_URL &&
    input.argv[2] === undefined
  )
    return "setup";
  return "serve";
}

// Bun autoloads .env from the working directory, not the exe's directory,
// so an installed exe launched from elsewhere (a shortcut, Run, a terminal)
// would otherwise look unconfigured and re-enter setup.
export function loadInstalledEnv(input: {
  execPath: string;
  env: NodeJS.ProcessEnv;
  fs?: Pick<typeof nodeFs, "readFileSync">;
}): boolean {
  const file = path.join(path.dirname(input.execPath), ".env");
  let text: string;
  try {
    text = (input.fs ?? nodeFs).readFileSync(file, "utf8");
  } catch {
    return false;
  }
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (input.env[key] === undefined) input.env[key] = value;
  }
  return true;
}
