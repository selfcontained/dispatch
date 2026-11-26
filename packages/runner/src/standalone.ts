import { packageVersion, gitSha, buildRevision, streamHelper } from "./generated/runtime-assets.js";
import { dispatchRunnerMode } from "./program.js";
import { shouldSkipAutomaticMacPathProbe } from "./platform/posix-user/mac-path-privacy.js";

export const assets = { build: {version: packageVersion, revision: buildRevision}, packageVersion, gitSha, streamHelper };
if (import.meta.main && !await dispatchRunnerMode(process.argv.slice(2), assets, shouldSkipAutomaticMacPathProbe, () => {})) {
  process.stderr.write(`Unknown runner mode: ${process.argv[2] ?? "(none)"}\n`);
  process.exitCode = 2;
}
