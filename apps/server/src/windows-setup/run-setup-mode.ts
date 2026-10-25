import { packageVersion } from "../generated/runtime-assets.js";
import { installDir, type SetupEnv } from "./env-file.js";
import { openBrowser as realOpenBrowser } from "./open-browser.js";
import { startSetupServer as realStartSetupServer } from "./setup-server.js";

// Long enough for the Done page to see the installed server and redirect.
const DEFAULT_CLOSE_DELAY_MS = 10_000;

// A double-clicked exe's console closes with the process, taking the error
// with it; hold it open until the user has read the message.
export function waitForEnter(
  prompt: string,
  deps: { log?: (line: string) => void; stdin?: NodeJS.ReadableStream } = {}
): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const stdin = deps.stdin ?? process.stdin;
  log(prompt);
  return new Promise((resolve) => {
    const onData = () => {
      stdin.off("data", onData);
      resolve();
    };
    stdin.on("data", onData);
  });
}

export async function runSetupMode(
  deps: {
    startSetupServer?: typeof realStartSetupServer;
    openBrowser?: (url: string) => Promise<void>;
    log?: (line: string) => void;
    closeDelayMs?: number;
  } = {}
): Promise<SetupEnv> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const { url, installed, close } = await (
    deps.startSetupServer ?? realStartSetupServer
  )({
    installDir: installDir(),
    execPath: process.execPath,
    platform: process.platform,
    version: packageVersion,
  });
  log(`Dispatch setup: opening ${url} in your browser`);
  await (deps.openBrowser ?? realOpenBrowser)(url);
  const env = await installed;
  Object.assign(process.env, env);
  log(`Dispatch is running at http://127.0.0.1:${env.DISPATCH_PORT}`);
  setTimeout(
    () => void close(),
    deps.closeDelayMs ?? DEFAULT_CLOSE_DELAY_MS
  ).unref();
  return env;
}
