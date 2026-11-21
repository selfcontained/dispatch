import { constants, type Stats } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
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

const PREPARATION_RETRY_MS = 60_000;

export function createRunnerArtifactSource(
  build: { revision: string; version: string; compiled: boolean },
  now: () => number = Date.now
) {
  const { revision, version, compiled } = build;
  const devDir = process.env.DISPATCH_RUNNER_ARTIFACT_DEV_DIR?.trim();
  const trustedRoot = process.env.DISPATCH_RUNNER_ARTIFACT_TRUST_ROOT?.trim();
  const tag = packageVersionTag(version);
  const source = devDir ? "dev" : "release";
  const archive = devDir
    ? path.join(resolveConfiguredPath(devDir), RELEASE_ARTIFACT_NAME)
    : tag
      ? cachedTarballPath(tag)
      : "";
  const companionDir = devDir
    ? path.dirname(archive)
    : path.join(path.dirname(archive), `runner-${tag}`);
  let loaded: Promise<ArtifactSet> | undefined;
  let failure: { error: unknown; retryAt: number } | undefined;
  let publishedDigest: string | undefined;

  const filePath = (name: RunnerArtifactName) =>
    name === RELEASE_ARTIFACT_NAME ? archive : path.join(companionDir, name);

  async function check<T>(
    names: RunnerArtifactName[],
    verify: () => Promise<T>
  ) {
    try {
      return await verify();
    } catch (error) {
      if (source === "release") {
        // A malformed companion directory may itself be a symlink. Never
        // follow it when invalidating anything underneath it.
        const directory = await lstat(companionDir).catch(() => undefined);
        await Promise.allSettled(
          names.map(async (name) => {
            if (name === RELEASE_ARTIFACT_NAME || directory?.isDirectory())
              await rm(filePath(name), { force: true, recursive: true });
          })
        );
      }
      throw error;
    }
  }

  async function load(): Promise<ArtifactSet> {
    if (source === "release") {
      if (!tag) throw new Error("The running build has no release tag");
      if ((await getGitHubRepo()) !== RELEASE_REPO)
        throw new Error("Runner releases are signed by selfcontained/dispatch");
      const directory = await lstat(companionDir).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        }
      );
      if (directory && !directory.isDirectory()) {
        await rm(companionDir, { force: true });
        throw new Error(
          "Expected a regular runner release companion directory"
        );
      }
      const archivePresent = await check([RELEASE_ARTIFACT_NAME], () =>
        regularFile(archive)
      );
      const missing: RunnerArtifactName[] = [];
      for (const name of RELEASE_COMPANIONS) {
        if (!(await check([name], () => regularFile(filePath(name)))))
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
              destination: filePath(name),
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

    const files: ArtifactFile[] = [];
    for (const name of source === "dev" ? DEV_FILES : RUNNER_ARTIFACT_FILES) {
      files.push(
        await check([name], async () => {
          const file = filePath(name);
          const stat = await regularFile(file);
          if (!stat) throw new Error(`Missing runner artifact: ${name}`);
          return { name, path: file, stat, sha256: await hashRegular(file) };
        })
      );
    }
    if (source === "release") {
      const expected = publishedDigest;
      if (expected)
        await check([RELEASE_ARTIFACT_NAME], async () => {
          verifyReleaseTarballDigest(
            files.find((file) => file.name === RELEASE_ARTIFACT_NAME)!.sha256,
            expected
          );
        });
      const root = trustedRoot ? resolveConfiguredPath(trustedRoot) : undefined;
      for (const name of DEV_FILES) {
        const bundle = `${name}.sigstore.json` as const;
        await check([name, bundle], () =>
          verifyRunnerReleaseAttestation({
            file: filePath(name),
            bundle: filePath(bundle),
            repo: RELEASE_REPO,
            trustedRoot: root,
            runCommand,
          })
        );
      }
    }
    await check([...DEV_FILES], () =>
      verifyRunnerArchive({
        archive,
        version,
        revision,
        runCommand,
        bootstrapSha256: files.find((file) => file.name === BOOTSTRAP)!.sha256,
      })
    );
    return { source, files };
  }

  function preparationFailed() {
    return failure !== undefined && now() < failure.retryAt;
  }

  return {
    enabled: Boolean(devDir || (compiled && tag)),
    kind: source,
    preparationFailed,
    async get() {
      if (failure) {
        if (preparationFailed()) throw failure.error;
        failure = undefined;
      }
      const pending = (loaded ??= load());
      try {
        const artifacts = await pending;
        for (const file of artifacts.files) {
          await check([file.name], async () => {
            const stat = await regularFile(file.path);
            if (!stat || !unchanged(file.stat, stat))
              throw new Error("Runner artifact changed after verification");
          });
        }
        return artifacts;
      } catch (error) {
        if (loaded === pending) {
          failure = { error, retryAt: now() + PREPARATION_RETRY_MS };
          loaded = undefined;
        }
        throw error;
      }
    },
  };
}

export type RunnerArtifactSource = ReturnType<
  typeof createRunnerArtifactSource
>;

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
