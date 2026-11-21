import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { hashRegular } from "../update-recovery/files.js";

import type { RunCommand } from "./release-helpers.js";

export function expectedArtifactMember(tag: string): string {
  const platform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : null;
  const arch =
    process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!platform || !arch)
    throw new Error(
      `Unsupported Dispatch runtime platform: ${process.platform}/${process.arch}`
    );
  return `dist/bun/dispatch-${tag.replace(/^v/, "")}-bun-${platform}-${arch}`;
}

async function tarMemberText(
  tarballPath: string,
  member: string,
  maxBytes = Infinity
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["xOf", tarballPath, member], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill();
        reject(
          new Error(`Release archive member ${member} exceeds the size limit`)
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString("utf8"))
        : reject(
            new Error(
              `Unable to extract ${member}: ${Buffer.concat(errors).toString("utf8").trim()}`
            )
          )
    );
  });
}

async function extractTarMember(
  tarballPath: string,
  member: string,
  destination: string
): Promise<void> {
  const child = spawn("tar", ["xOf", tarballPath, member], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  await pipeline(child.stdout, createWriteStream(destination, { mode: 0o700 }));
  if ((await exited) !== 0)
    throw new Error(
      `Unable to extract ${member}: ${Buffer.concat(errors).toString("utf8").trim()}`
    );
  await chmod(destination, 0o755);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export type RecoveryCapability = { protocol: 1; sha256: string };

/** GitHub's separately fetched asset digest authenticates the archive. */
export function verifyReleaseTarballDigest(
  actualSha256: string,
  expectedSha256: string
): void {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || actualSha256 !== expectedSha256)
    throw new Error(
      "Release package does not match GitHub's published asset digest"
    );
}

export async function verifyRecoveryCapability(input: {
  tarballPath: string;
  tag: string;
  expectedTarballSha256: string;
}): Promise<RecoveryCapability> {
  verifyReleaseTarballDigest(
    await hashRegular(input.tarballPath),
    input.expectedTarballSha256
  );
  const member = expectedArtifactMember(input.tag);
  let manifest: {
    formatVersion?: number;
    artifacts?: Record<string, { protocol?: number; sha256?: string }>;
  } | null;
  try {
    manifest = JSON.parse(
      await tarMemberText(
        input.tarballPath,
        "dist/bun/RECOVERY_CAPABILITIES.json"
      )
    );
  } catch {
    throw new Error(
      "Target cannot be trialled safely: recovery capability manifest is missing or invalid"
    );
  }
  const capability = manifest?.artifacts?.[member.split("/").pop()!];
  if (
    manifest?.formatVersion !== 1 ||
    capability?.protocol !== 1 ||
    typeof capability.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(capability.sha256)
  )
    throw new Error(
      "Target cannot be trialled safely: recovery protocol v1 capability is missing"
    );
  return { protocol: 1, sha256: capability.sha256 };
}

export const RUNNER_PLATFORMS = ["linux/x64", "linux/arm64"] as const;

/** The same GitHub CLI provenance policy used by the runner installer. */
export async function verifyRunnerReleaseAttestation(input: {
  file: string;
  bundle: string;
  repo: string;
  trustedRoot?: string;
  runCommand: RunCommand;
}): Promise<void> {
  const { file, bundle, repo, trustedRoot, runCommand } = input;
  await runCommand(
    "gh",
    [
      "attestation",
      "verify",
      file,
      "--hostname",
      "github.com",
      "--bundle",
      bundle,
      "--repo",
      repo,
      "--signer-workflow",
      `${repo}/.github/workflows/release.yml`,
      ...(trustedRoot ? ["--custom-trusted-root", trustedRoot] : []),
    ],
    { timeoutMs: 120_000 }
  );
}

export async function verifyRunnerArchive(input: {
  archive: string;
  version: string;
  revision: string;
  platform: (typeof RUNNER_PLATFORMS)[number];
  bootstrapSha256: string;
  runCommand: RunCommand;
}): Promise<void> {
  const { archive, version, revision, platform, bootstrapSha256, runCommand } =
    input;
  const identityMember = "dist/bun/BUILD_IDENTITY.json";
  const bootstrapMember = "bin/install-dispatch-runner.sh";
  const members = [
    identityMember,
    bootstrapMember,
    "bin/dispatch-runner",
    "bin/dispatch-runner.service",
    "bin/runner-handoff-v1.py",
    `dist/bun/dispatch-${version}-bun-${platform.replace("/", "-")}`,
  ];
  const { stdout } = await runCommand("tar", ["tvf", archive]);
  const entries = stdout.trimEnd().split("\n");
  if (entries.length !== members.length)
    throw new Error("Runner archive contains unexpected members");
  for (const member of members) {
    const matches = entries.filter((entry) => entry.endsWith(` ${member}`));
    if (matches.length !== 1 || !matches[0]?.startsWith("-"))
      throw new Error(`Runner archive must contain one regular ${member}`);
  }
  const identity: unknown = JSON.parse(
    await tarMemberText(archive, identityMember, 4096)
  );
  if (
    typeof identity !== "object" ||
    identity === null ||
    !("revision" in identity) ||
    identity.revision !== revision ||
    !("version" in identity) ||
    identity.version !== version
  )
    throw new Error("Runner archive is for a different Dispatch build");
  const bootstrap = await tarMemberText(archive, bootstrapMember, 256 * 1024);
  if (createHash("sha256").update(bootstrap).digest("hex") !== bootstrapSha256)
    throw new Error(
      "Runner bootstrap does not match the script in the release archive"
    );
}

/** Validates a release tarball then atomically replaces the fixed runtime path. */
export async function verifyAndStageRuntime(input: {
  tarballPath: string;
  tag: string;
  livePath: string;
  runCommand: RunCommand;
}): Promise<void> {
  const { tarballPath, tag, livePath, runCommand } = input;
  const listing = await runCommand("tar", ["tzf", tarballPath]);
  const entries = listing.stdout.split("\n");
  const unsafeEntries = entries.filter(
    (entry) => entry.startsWith("/") || entry.includes("../")
  );
  if (unsafeEntries.length)
    throw new Error(
      `Release artifact contains unsafe paths: ${unsafeEntries.slice(0, 5).join(", ")}`
    );
  const member = expectedArtifactMember(tag);
  if (entries.filter((entry) => entry.trim() === member).length !== 1)
    throw new Error(`Release artifact must contain exactly one ${member}`);
  const verbose = await runCommand("tar", ["tvzf", tarballPath, member]);
  if (!verbose.stdout.trim().startsWith("-"))
    throw new Error(`Release artifact member ${member} is not a regular file`);
  const checksums = await tarMemberText(tarballPath, "dist/bun/SHA256SUMS.txt");
  const line = checksums
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.split(/\s+/)[1] === member.split("/").pop());
  const expected = line?.split(/\s+/)[0];
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected))
    throw new Error(`Release artifact has no valid checksum for ${member}`);

  const runtimeDir = path.dirname(livePath);
  await mkdir(runtimeDir, { recursive: true });
  await Promise.all(
    (await readdir(runtimeDir))
      .filter((name) => name.startsWith(".dispatch.next."))
      .map((name) => rm(path.join(runtimeDir, name), { force: true }))
  );
  const stagingPath = path.join(
    runtimeDir,
    `.dispatch.next.${process.pid}.${Date.now()}`
  );
  try {
    await extractTarMember(tarballPath, member, stagingPath);
    if ((await sha256File(stagingPath)) !== expected)
      throw new Error(`Checksum mismatch for ${member}`);
    const previousPath = `${livePath}.previous`;
    try {
      await lstat(livePath);
      const previousTemp = `${previousPath}.tmp.${process.pid}.${Date.now()}`;
      await link(livePath, previousTemp);
      await rename(previousTemp, previousPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(stagingPath, livePath);
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => {});
    throw error;
  }
}
