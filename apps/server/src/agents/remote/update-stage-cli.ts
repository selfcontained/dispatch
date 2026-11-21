import { randomBytes } from "node:crypto";
import { lstat, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { packageVersion } from "../../generated/runtime-assets.js";
import {
  compiledRunnerDevKey,
  compiledRunnerUpdateKeys,
} from "./update-keys.js";
import {
  RUNNER_UPDATE_LAYOUT,
  RunnerUpdateRefused,
  stageRunnerUpdate,
  type RunnerUpdateLayout,
} from "./update-verify.js";

/**
 * Exit status of `dispatch runner-update-stage`. The systemd unit maps
 * single-flight contention to 75 through flock before this runs.
 */
export const STAGE_EXIT = { ok: 0, refused: 65, failed: 70 } as const;

/**
 * A development-compiled binary (its own dev trust root) may run against a
 * fixture tree. A production binary always uses the fixed root layout.
 */
function layoutAndHost(): {
  layout: RunnerUpdateLayout;
  host: { os: string; arch: string };
  trustedUid: number;
} {
  const root = process.env.DISPATCH_RUNNER_UPDATE_TEST_ROOT;
  if (compiledRunnerDevKey() && root && path.isAbsolute(root)) {
    const [os, arch] = (
      process.env.DISPATCH_RUNNER_UPDATE_TEST_HOST ?? ""
    ).split("/");
    return {
      layout: {
        config: path.join(root, RUNNER_UPDATE_LAYOUT.config),
        installed: path.join(root, RUNNER_UPDATE_LAYOUT.installed),
        staging: path.join(root, RUNNER_UPDATE_LAYOUT.staging),
        state: path.join(root, RUNNER_UPDATE_LAYOUT.state),
      },
      host: { os: os ?? "", arch: arch ?? "" },
      trustedUid: process.getuid?.() ?? -1,
    };
  }
  return {
    layout: RUNNER_UPDATE_LAYOUT,
    host: { os: process.platform, arch: process.arch },
    trustedUid: 0,
  };
}

/** The last result, for the supervisor to read; never the caller's text. */
async function recordResult(state: string, uid: number, result: object) {
  const stat = await lstat(state).catch(() => undefined);
  if (!stat?.isDirectory() || stat.uid !== uid || stat.mode & 0o077) return;
  const temporary = path.join(
    state,
    `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ ...result, at: new Date().toISOString() }) + "\n"
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path.join(state, "last-stage.json"));
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** `dispatch runner-update-stage <version>_linux_<arch>_<sha256>` */
export async function runRunnerUpdateStage(argv: string[]) {
  const { layout, host, trustedUid } = layoutAndHost();
  if (argv.length !== 1) {
    console.error(
      "Usage: dispatch runner-update-stage VERSION_linux_ARCH_SHA256"
    );
    process.exitCode = STAGE_EXIT.refused;
    return;
  }
  try {
    const result = await stageRunnerUpdate(argv[0], {
      layout,
      keys: compiledRunnerUpdateKeys(),
      host,
      installedVersion: packageVersion,
      trustedUid,
    });
    const summary = { outcome: result.outcome, target: result.target };
    console.log(JSON.stringify(summary));
    await recordResult(layout.state, trustedUid, summary);
    process.exitCode = STAGE_EXIT.ok;
  } catch (error) {
    const refused = error instanceof RunnerUpdateRefused;
    const reason = refused ? error.reason : "failed";
    console.error(
      `Runner update staging refused (${reason}): ${(error as Error).message}`
    );
    // Only a parsed request is echoed into the record.
    await recordResult(layout.state, trustedUid, {
      outcome: "refused",
      reason,
    });
    process.exitCode = refused ? STAGE_EXIT.refused : STAGE_EXIT.failed;
  }
}
