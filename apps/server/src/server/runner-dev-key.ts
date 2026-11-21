import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const runnerDevKeyDirectory = path.join(
  homedir(),
  ".local/state/dispatch/runner-update-dev"
);

export function readRunnerDevPublicKey() {
  return readFile(path.join(runnerDevKeyDirectory, "public.pem"), "utf8");
}
