import { RUNNER_UPDATE_VERSION, type RunnerArch } from "./update-manifest.js";

export const RUNNER_UPDATE_PREFIX = "/api/v1/runner-artifacts";

export function resolveRunnerUpdatePath(url: string) {
  const match =
    /^\/api\/v1\/runner-artifacts\/([a-f0-9]{7,40})\/update\/([^/]{1,128})\/linux\/(x64|arm64)\/([a-f0-9]{64})\/(manifest\.json|dispatch-runner)$/.exec(
      url
    );
  if (!match || !RUNNER_UPDATE_VERSION.test(match[2]!)) return undefined;
  const [, revision, version, arch, sha256, file] = match;
  return {
    revision: revision!,
    version: version!,
    arch: arch as RunnerArch,
    sha256: sha256!,
    file: file as "manifest.json" | "dispatch-runner",
  };
}
