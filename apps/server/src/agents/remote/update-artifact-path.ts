import { RUNNER_UPDATE_VERSION, type RunnerArch } from "./update-manifest.js";

export const RUNNER_UPDATE_PREFIX = "/api/v1/runner-artifacts";

export const RUNNER_UPDATE_FILES = [
  "manifest.json",
  "dispatch-runner",
  "dispatch-runner.gz",
] as const;
export type RunnerUpdateFile = (typeof RUNNER_UPDATE_FILES)[number];

/** The root updater's fixed route; the signed digest names the build. */
export function runnerUpdateFilePath(
  update: { version: string; arch: RunnerArch; sha256: string },
  file: RunnerUpdateFile
) {
  return `${RUNNER_UPDATE_PREFIX}/update/${update.version}/linux/${update.arch}/${update.sha256}/${file}`;
}

/**
 * The revision segment is optional. The installed updater knows only the
 * signed version, platform and digest, which already identify one build.
 */
export function resolveRunnerUpdatePath(url: string) {
  const match =
    /^\/api\/v1\/runner-artifacts\/(?:([a-f0-9]{7,40})\/)?update\/([^/]{1,128})\/linux\/(x64|arm64)\/([a-f0-9]{64})\/(manifest\.json|dispatch-runner(?:\.gz)?)$/.exec(
      url
    );
  if (!match || !RUNNER_UPDATE_VERSION.test(match[2]!)) return undefined;
  const [, revision, version, arch, sha256, file] = match;
  return {
    revision,
    version: version!,
    arch: arch as RunnerArch,
    sha256: sha256!,
    file: file as RunnerUpdateFile,
  };
}
