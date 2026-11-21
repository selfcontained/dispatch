import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import {
  cachedTarballPath,
  downloadReleaseCompanion,
  ensureCachedTarball,
  RELEASE_ARTIFACT_NAME,
} from "../release-tarball-cache.js";
import { packageVersionTag } from "../release-store.js";
import { resolveConfiguredPath } from "../shared/lib/resolve-tilde.js";
import { runCommand } from "../shared/lib/run-command.js";
import { hashRegular } from "../update-recovery/files.js";
import {
  RUNNER_PLATFORMS,
  verifyReleaseTarballDigest,
  verifyRunnerArchive,
  verifyRunnerReleaseAttestation,
} from "./release-artifact.js";
import { fetchReleaseMetadata, getGitHubRepo } from "./release-helpers.js";

const BOOTSTRAP = "install-dispatch-runner.sh";
const BOOTSTRAP_BUNDLE = "install-dispatch-runner.sh.sigstore.json";
const ARCHIVE_BUNDLE = "dispatch-server.tar.gz.sigstore.json";
const RELEASE_REPO = "selfcontained/dispatch";
const DEV_FILES = [BOOTSTRAP, RELEASE_ARTIFACT_NAME] as const;
const RELEASE_COMPANIONS = [
  BOOTSTRAP,
  BOOTSTRAP_BUNDLE,
  ARCHIVE_BUNDLE,
] as const;
export const RUNNER_ARTIFACT_FILES = [
  ...DEV_FILES,
  BOOTSTRAP_BUNDLE,
  ARCHIVE_BUNDLE,
] as const;
type RunnerArtifactName = (typeof RUNNER_ARTIFACT_FILES)[number];

type ArtifactFile = {
  name: RunnerArtifactName;
  path: string;
  stat: Stats;
  sha256: string;
};

type ArtifactSet = {
  source: "release" | "dev";
  files: ArtifactFile[];
};

function unchanged(before: Stats, after: Stats) {
  return (
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function regularFile(file: string): Promise<Stats | null> {
  const stat = await lstat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (stat && (!stat.isFile() || stat.size === 0))
    throw new Error(`Expected a nonempty, regular runner artifact: ${file}`);
  return stat;
}

export async function openRunnerArtifact(file: ArtifactFile) {
  const handle = await open(
    file.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!unchanged(file.stat, await handle.stat()))
      throw new Error("Runner artifact changed after verification");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export function createRunnerArtifactSource(build: {
  revision: string;
  version: string;
  compiled: boolean;
}) {
  const { revision, version, compiled } = build;
  const devDir = process.env.DISPATCH_RUNNER_ARTIFACT_DEV_DIR?.trim();
  const trustedRoot = process.env.DISPATCH_RUNNER_ARTIFACT_TRUST_ROOT?.trim();
  const tag = packageVersionTag(version);
  let loaded: Promise<ArtifactSet> | undefined;
  let publishedDigest: string | undefined;

  async function load(): Promise<ArtifactSet> {
    const source = devDir ? "dev" : "release";
    let archive: string;
    let companionDir: string;
    if (devDir) {
      companionDir = resolveConfiguredPath(devDir);
      archive = path.join(companionDir, RELEASE_ARTIFACT_NAME);
    } else {
      if (!tag) throw new Error("The running build has no release tag");
      if ((await getGitHubRepo()) !== RELEASE_REPO)
        throw new Error("Runner releases are signed by selfcontained/dispatch");
      archive = cachedTarballPath(tag);
      companionDir = path.join(path.dirname(archive), `runner-${tag}`);
      const archivePresent = await regularFile(archive);
      const missing = [];
      for (const name of RELEASE_COMPANIONS) {
        if (!(await regularFile(path.join(companionDir, name))))
          missing.push(name);
      }
      if (!archivePresent || missing.length) {
        const release = await fetchReleaseMetadata(tag);
        if (release?.tag !== tag || !release.artifactSha256)
          throw new Error(`Release ${tag} has no published archive digest`);
        publishedDigest = release.artifactSha256;
        const downloads = await Promise.allSettled([
          ...missing.map((name) =>
            downloadReleaseCompanion({
              tag,
              repo: RELEASE_REPO,
              name,
              destination: path.join(companionDir, name),
            })
          ),
          ...(archivePresent
            ? []
            : [ensureCachedTarball({ tag, repo: RELEASE_REPO })]),
        ]);
        for (const download of downloads)
          if (download.status === "rejected") throw download.reason;
      }
    }

    const files = await Promise.all(
      (devDir ? DEV_FILES : RUNNER_ARTIFACT_FILES).map(async (name) => {
        const file =
          name === RELEASE_ARTIFACT_NAME
            ? archive
            : path.join(companionDir, name);
        const stat = await regularFile(file);
        if (!stat) throw new Error(`Missing runner artifact: ${name}`);
        return { name, path: file, stat, sha256: await hashRegular(file) };
      })
    );
    if (source === "release") {
      if (publishedDigest)
        verifyReleaseTarballDigest(
          files.find((file) => file.name === RELEASE_ARTIFACT_NAME)!.sha256,
          publishedDigest
        );
      const root = trustedRoot ? resolveConfiguredPath(trustedRoot) : undefined;
      await Promise.all(
        DEV_FILES.map((name) =>
          verifyRunnerReleaseAttestation({
            file:
              name === RELEASE_ARTIFACT_NAME
                ? archive
                : path.join(companionDir, name),
            bundle: path.join(companionDir, `${name}.sigstore.json`),
            repo: RELEASE_REPO,
            trustedRoot: root,
            runCommand,
          })
        )
      );
    }
    await verifyRunnerArchive({
      archive,
      version,
      revision,
      runCommand,
      bootstrapSha256: files.find((file) => file.name === BOOTSTRAP)!.sha256,
    });
    for (const file of files) {
      if (!unchanged(file.stat, await lstat(file.path)))
        throw new Error("Runner artifact changed during verification");
    }
    return { source, files };
  }

  return {
    enabled: Boolean(devDir || (compiled && tag)),
    async get() {
      const pending = (loaded ??= load());
      try {
        const artifacts = await pending;
        for (const file of artifacts.files) {
          const stat = await regularFile(file.path);
          if (!stat || !unchanged(file.stat, stat))
            throw new Error("Runner artifact changed after verification");
        }
        return artifacts;
      } catch (error) {
        if (loaded === pending) loaded = undefined;
        throw error;
      }
    },
  };
}

export function describeRunnerArtifacts(
  revision: string,
  version: string,
  artifacts: ArtifactSet
) {
  return {
    revision,
    version,
    platforms: RUNNER_PLATFORMS,
    source: artifacts.source,
    verified: artifacts.source === "release",
    files: Object.fromEntries(
      artifacts.files.map(({ name, stat, sha256 }) => [
        name,
        { size: stat.size, sha256 },
      ])
    ),
  };
}
