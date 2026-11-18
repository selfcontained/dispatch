import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { readReleaseChannel } from "../release-info.js";
import {
  fetchGitHubReleases,
  getGitHubRepo,
  compareSemver,
} from "../server/release-helpers.js";

export function installRunnerCommand(tag: string) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("Invalid runner release");
  return [
    "(",
    "  set -e",
    `  tag=${tag}`,
    "  dir=$(mktemp -d)",
    "  trap 'rm -rf -- \"$dir\"' EXIT",
    '  base="https://github.com/selfcontained/dispatch/releases/download/$tag"',
    '  curl -qfsSL --proto "=https" --proto-redir "=https" "$base/install-dispatch-runner.sh" -o "$dir/install.sh"',
    '  curl -qfsSL --proto "=https" --proto-redir "=https" "$base/install-dispatch-runner.sh.sigstore.json" -o "$dir/install.json"',
    '  gh attestation verify "$dir/install.sh" --hostname github.com --bundle "$dir/install.json" --repo selfcontained/dispatch --signer-workflow selfcontained/dispatch/.github/workflows/release.yml',
    '  sudo bash "$dir/install.sh" install --tag "$tag"',
    ")",
  ].join("\n");
}

export function registerRunnerInstaller(app: FastifyInstance, pool: Pool) {
  let cached:
    | { fetched: number; releases: ReturnType<typeof fetchGitHubReleases> }
    | undefined;
  app.get("/api/v1/runners/installer", async (_req, reply) => {
    if ((await getGitHubRepo()) !== "selfcontained/dispatch")
      return { tag: null, command: null };
    try {
      if (!cached || Date.now() - cached.fetched > 300_000)
        cached = { fetched: Date.now(), releases: fetchGitHubReleases() };
      const [releases, channel] = await Promise.all([
        cached.releases,
        readReleaseChannel(pool),
      ]);
      const latest = releases
        .filter(
          (r) =>
            r.hasRunnerInstaller &&
            /^v\d+\.\d+\.\d+$/.test(r.tag) &&
            (!r.prerelease || channel === "preview")
        )
        .sort((a, b) => compareSemver(b.tag, a.tag))[0];
      return {
        tag: latest?.tag ?? null,
        command: latest ? installRunnerCommand(latest.tag) : null,
      };
    } catch {
      cached = undefined;
      return reply
        .code(503)
        .send({ error: "Could not check runner releases." });
    }
  });
}
