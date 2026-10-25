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
