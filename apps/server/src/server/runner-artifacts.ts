import { constants, type Stats } from "node:fs";
import { lstat, mkdtemp, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  compiledRunnerDevKey,
  productionRunnerUpdateKeys,
  RUNNER_UPDATE_DEV_KEY_ID,
} from "../agents/remote/update-keys.js";
import {
  runnerExecutableMember,
  runnerManifestName,
  RUNNER_ARCHES,
  RUNNER_UPDATE_MANIFEST_LIMIT,
  verifyRunnerUpdateEnvelope,
  type RunnerArch,
} from "../agents/remote/update-manifest.js";
import {
  cachedTarballPath,
  downloadReleaseCompanion,
} from "../release-tarball-cache.js";
import { packageVersionTag } from "../release-store.js";
import { resolveConfiguredPath } from "../shared/lib/resolve-tilde.js";
import { runCommand } from "../shared/lib/run-command.js";
import { hashRegular } from "../update-recovery/files.js";
import {
  extractTarMember,
  verifyReleaseTarballDigest,
  verifyRunnerArchive,
  verifyRunnerReleaseAttestation,
} from "./release-artifact.js";
import { fetchReleaseMetadata, getGitHubRepo } from "./release-helpers.js";

import { readRunnerDevPublicKey } from "./runner-dev-key.js";

const BOOTSTRAP = "install-dispatch-runner.sh";
const BOOTSTRAP_BUNDLE = "install-dispatch-runner.sh.sigstore.json";
const RELEASE_REPO = "selfcontained/dispatch";
export { RUNNER_ARCHES };
export type { RunnerArch };
export const runnerArchiveName = (arch: RunnerArch) =>
  `dispatch-runner-linux-${arch}.tar.gz` as const;
export const runnerDescriptorName = (arch: RunnerArch) =>
  `descriptor-linux-${arch}.json` as const;
const archiveBundleName = (arch: RunnerArch) =>
  `${runnerArchiveName(arch)}.sigstore.json` as const;
export class RunnerPayloadUnavailable extends Error {}
const RUNNER_ARTIFACT_FILES = [
  BOOTSTRAP,
  BOOTSTRAP_BUNDLE,
  ...RUNNER_ARCHES.flatMap((arch) => [
    runnerArchiveName(arch),
    archiveBundleName(arch),
  ]),
] as const;
type RunnerArtifactName = (typeof RUNNER_ARTIFACT_FILES)[number];

function runnerBootstrapName(arch: RunnerArch) {
  return `install-dispatch-runner-linux-${arch}.sh` as const;
}

function publicArtifactName(name: RunnerArtifactName, arch: RunnerArch) {
  if (name === BOOTSTRAP) return runnerBootstrapName(arch);
  if (name === BOOTSTRAP_BUNDLE)
    return `${runnerBootstrapName(arch)}.sigstore.json` as const;
  return name;
}

const routes = new Map<
  string,
  { arch: RunnerArch; asset?: RunnerArtifactName }
>();
for (const arch of RUNNER_ARCHES) {
  routes.set(runnerDescriptorName(arch), { arch });
  for (const asset of [
    BOOTSTRAP,
    BOOTSTRAP_BUNDLE,
    runnerArchiveName(arch),
    archiveBundleName(arch),
  ] as const)
    routes.set(publicArtifactName(asset, arch), { arch, asset });
}

export function resolveRunnerArtifact(name: string) {
  return routes.get(name);
}

type ArtifactFile<Name extends string = RunnerArtifactName> = {
  name: Name;
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

export async function openRunnerArtifact(
  file: Pick<ArtifactFile, "path" | "stat">
) {
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
  const directory = devDir
    ? resolveConfiguredPath(devDir)
    : path.join(path.dirname(cachedTarballPath(tag ?? "")), `runner-${tag}`);
  const states = new Map<
    RunnerArch | undefined,
    {
      loaded?: Promise<ArtifactSet>;
      failure?: { error: unknown; retryAt: number };
    }
  >();
  const updateStates = new Map<
    RunnerArch,
    {
      loaded?: Promise<RunnerUpdateArtifactSet>;
      failure?: { error: unknown; retryAt: number };
    }
  >();
  const filePath = (name: RunnerArtifactName) => path.join(directory, name);

  async function check<T>(
    names: RunnerArtifactName[],
    verify: () => Promise<T>
  ) {
    try {
      return await verify();
    } catch (error) {
      if (
        source === "release" &&
        (await lstat(directory).catch(() => undefined))?.isDirectory()
      ) {
        await Promise.allSettled(
          names.map((name) =>
            rm(filePath(name), { force: true, recursive: true })
          )
        );
      }
      throw error;
    }
  }

  async function load(arch?: RunnerArch): Promise<ArtifactSet> {
    const name = arch ? runnerArchiveName(arch) : BOOTSTRAP;
    const bundle = arch ? archiveBundleName(arch) : BOOTSTRAP_BUNDLE;
    const names: RunnerArtifactName[] =
      source === "release" ? [name, bundle] : [name];
    let expected: string | undefined;
    if (source === "release") {
      if (!tag) throw new Error("The running build has no release tag");
      if ((await getGitHubRepo()) !== RELEASE_REPO)
        throw new Error("Runner releases are signed by selfcontained/dispatch");
      const stat = await lstat(directory).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        }
      );
      if (stat && !stat.isDirectory()) {
        await rm(directory, { force: true });
        throw new Error(
          "Expected a regular runner release companion directory"
        );
      }
      const missing: RunnerArtifactName[] = [];
      for (const asset of names) {
        if (!(await check([asset], () => regularFile(filePath(asset)))))
          missing.push(asset);
      }
      if (missing.length) {
        const release = await fetchReleaseMetadata(tag, true);
        const assets = release?.tag === tag ? release.assets : undefined;
        if (
          !names.every((asset) => assets?.some((entry) => entry.name === asset))
        )
          throw new RunnerPayloadUnavailable(
            `Dispatch release ${tag} does not publish an attested ${arch ? `Linux ${arch} runner payload` : "runner installer"}. Upgrade the controller to a release with native runner payloads.`
          );
        const digest = assets?.find((entry) => entry.name === name)?.digest;
        if (arch && !/^sha256:[a-f0-9]{64}$/.test(digest ?? ""))
          throw new Error(`Release ${tag} has no published digest for ${name}`);
        expected = digest?.slice(7);
        const downloads = await Promise.allSettled(
          missing.map((asset) =>
            downloadReleaseCompanion({
              tag,
              repo: RELEASE_REPO,
              name: asset,
              destination: filePath(asset),
            })
          )
        );
        for (const download of downloads)
          if (download.status === "rejected") throw download.reason;
      }
    }

    const files = await Promise.all(
      names.map((asset) =>
        check([asset], async () => {
          const file = filePath(asset);
          const stat = await regularFile(file);
          if (!stat) throw new Error(`Missing runner artifact: ${asset}`);
          return {
            name: asset,
            path: file,
            stat,
            sha256: await hashRegular(file),
          };
        })
      )
    );
    const [artifact] = files;
    if (source === "release") {
      if (arch && expected)
        await check([name], async () =>
          verifyReleaseTarballDigest(artifact!.sha256, expected)
        );
      await check(names, () =>
        verifyRunnerReleaseAttestation({
          file: filePath(name),
          bundle: filePath(bundle),
          repo: RELEASE_REPO,
          trustedRoot: trustedRoot
            ? resolveConfiguredPath(trustedRoot)
            : undefined,
          runCommand,
        })
      );
    }
    if (arch) {
      const bootstrap = await get();
      await check([name], () =>
        verifyRunnerArchive({
          archive: filePath(name),
          version,
          revision,
          platform: `linux/${arch}`,
          runCommand,
          bootstrapSha256: bootstrap.files[0]!.sha256,
        })
      );
      files.push(...bootstrap.files);
    }
    return { source, files };
  }

  // Only the bootstrap gates the install command: /install cannot know the
  // host's architecture, so a failing arch payload surfaces as a 503 when the
  // installer fetches it.
  function preparationFailed() {
    const failure = states.get(undefined)?.failure;
    return failure !== undefined && now() < failure.retryAt;
  }

  async function get(arch?: RunnerArch) {
    let state = states.get(arch);
    if (!state) {
      state = {};
      states.set(arch, state);
    }
    if (state.failure && now() < state.failure.retryAt)
      throw state.failure.error;
    const pending = (state.loaded ??= load(arch));
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
      if (state.loaded === pending) {
        state.failure = { error, retryAt: now() + PREPARATION_RETRY_MS };
        state.loaded = undefined;
      }
      throw error;
    }
  }

  const updateEnabled =
    source === "dev"
      ? !compiled || Boolean(compiledRunnerDevKey())
      : Boolean(compiled && tag);

  async function loadUpdate(
    arch: RunnerArch,
    archive: ArtifactFile
  ): Promise<RunnerUpdateArtifactSet> {
    const name = runnerManifestName(arch);
    const envelopePath = path.join(directory, name);
    if (source === "release" && tag && !(await regularFile(envelopePath))) {
      const release = await fetchReleaseMetadata(tag, true);
      if (
        release?.tag !== tag ||
        !release.assets?.some((asset) => asset.name === name)
      )
        throw new RunnerPayloadUnavailable(
          `Dispatch release ${tag} does not publish ${name}`
        );
      await downloadReleaseCompanion({
        tag,
        repo: RELEASE_REPO,
        name,
        destination: envelopePath,
      });
    }
    const stat = await regularFile(envelopePath);
    if (!stat)
      throw new RunnerPayloadUnavailable(
        `Missing runner update asset: ${name}`
      );
    if (stat.size > RUNNER_UPDATE_MANIFEST_LIMIT)
      throw new Error("Runner update envelope exceeds the size limit");
    const handle = await openRunnerArtifact({
      path: envelopePath,
      stat,
    });
    let bytes: Buffer;
    try {
      bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read({ buffer: bytes });
      if (bytesRead !== stat.size || !unchanged(stat, await handle.stat()))
        throw new Error("Runner update envelope changed while reading");
      bytes = bytes.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const keys =
      source === "release"
        ? productionRunnerUpdateKeys
        : new Map([
            [
              RUNNER_UPDATE_DEV_KEY_ID,
              compiledRunnerDevKey() ?? (await readRunnerDevPublicKey()),
            ],
          ]);
    const manifest = verifyRunnerUpdateEnvelope(
      JSON.parse(bytes.toString("utf8")),
      keys
    );
    if (manifest.version !== version || manifest.arch !== arch)
      throw new Error(
        "Runner update manifest is for a different version or platform"
      );

    const staging = await mkdtemp(path.join(directory, ".runner-update-"));
    try {
      const candidate = path.join(staging, "dispatch-runner");
      await extractTarMember(
        archive.path,
        runnerExecutableMember(version, arch),
        candidate
      );
      // Recheck the archive identity after extracting the member by pathname.
      await get(arch);
      if ((await hashRegular(candidate)) !== manifest.sha256)
        throw new Error(
          "Runner executable does not match its signed update digest"
        );
      const executablePath = path.join(
        directory,
        `runner-${revision}-${arch}-${manifest.sha256}`
      );
      const candidateStat = await lstat(candidate);
      await rename(candidate, executablePath);
      const executableStat = await regularFile(executablePath);
      if (
        !executableStat ||
        executableStat.dev !== candidateStat.dev ||
        executableStat.ino !== candidateStat.ino
      )
        throw new Error("Verified runner executable was replaced");
      return {
        manifest,
        archive,
        envelope: { path: envelopePath, stat, bytes },
        executable: {
          name: "dispatch-runner",
          path: executablePath,
          stat: executableStat,
          sha256: manifest.sha256,
        },
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async function getUpdate(arch: RunnerArch) {
    if (!updateEnabled)
      throw new RunnerPayloadUnavailable(
        "Runner updates are disabled for this build."
      );
    const { files } = await get(arch);
    let state = updateStates.get(arch);
    if (!state) {
      state = {};
      updateStates.set(arch, state);
    }
    if (state.failure && now() < state.failure.retryAt)
      throw state.failure.error;
    const pending = (state.loaded ??= loadUpdate(arch, files[0]!));
    try {
      const artifacts = await pending;
      if (artifacts.archive !== files[0])
        throw new Error("Runner archive changed after update verification");
      for (const file of [artifacts.envelope, artifacts.executable]) {
        const stat = await regularFile(file.path);
        if (!stat || !unchanged(file.stat, stat))
          throw new Error("Runner update artifact changed after verification");
      }
      return artifacts;
    } catch (error) {
      if (state.loaded === pending) {
        state.failure = { error, retryAt: now() + PREPARATION_RETRY_MS };
        state.loaded = undefined;
      }
      throw error;
    }
  }

  return {
    enabled: Boolean(devDir || (compiled && tag)),
    kind: source,
    preparationFailed,
    get,
    getUpdate,
  };
}

type RunnerUpdateArtifactSet = {
  archive: ArtifactFile;
  manifest: ReturnType<typeof verifyRunnerUpdateEnvelope>;
  envelope: { path: string; stat: Stats; bytes: Buffer };
  executable: ArtifactFile<"dispatch-runner">;
};

export type RunnerArtifactSource = ReturnType<
  typeof createRunnerArtifactSource
>;

export function describeRunnerArtifacts(
  revision: string,
  version: string,
  artifacts: ArtifactSet,
  arch: RunnerArch
) {
  return {
    revision,
    version,
    platforms: [`linux/${arch}`],
    source: artifacts.source,
    verified: artifacts.source === "release",
    files: Object.fromEntries(
      artifacts.files.map(({ name, stat, sha256 }) => [
        publicArtifactName(name, arch),
        { size: stat.size, sha256 },
      ])
    ),
  };
}
