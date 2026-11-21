import { createPublicKey, verify, type KeyObject } from "node:crypto";

export const RUNNER_ARCHES = ["x64", "arm64"] as const;
export type RunnerArch = (typeof RUNNER_ARCHES)[number];

export const RUNNER_UPDATE_VERSION =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/;
export const RUNNER_UPDATE_DIGEST = /^[a-f0-9]{64}$/;
export const RUNNER_UPDATE_KEY_ID = /^[a-zA-Z0-9_-]{1,64}$/;
export const RUNNER_UPDATE_MANIFEST_LIMIT = 16 * 1024;

export type RunnerUpdateManifest = {
  version: string;
  os: "linux";
  arch: RunnerArch;
  sha256: string;
};

export function runnerManifestName(arch: RunnerArch) {
  return `dispatch-runner-linux-${arch}.manifest.json` as const;
}

export function runnerExecutableMember(version: string, arch: RunnerArch) {
  return `dist/bun/dispatch-${version}-bun-linux-${arch}`;
}

/** UTF-8 JSON, fixed field order, no whitespace or trailing newline. */
export function canonicalRunnerManifest({
  version,
  os,
  arch,
  sha256,
}: RunnerUpdateManifest) {
  return Buffer.from(JSON.stringify({ version, os, arch, sha256 }), "utf8");
}

export type RunnerUpdateKeys = ReadonlyMap<string, string | KeyObject>;

export function verifyRunnerUpdateEnvelope(
  envelope: unknown,
  keys: RunnerUpdateKeys
): RunnerUpdateManifest {
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !("manifest" in envelope) ||
    !("signatures" in envelope) ||
    !Array.isArray(envelope.signatures)
  )
    throw new Error("Invalid runner update envelope");

  const { manifest } = envelope;
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Object.keys(manifest).length !== 4 ||
    !("version" in manifest) ||
    typeof manifest.version !== "string" ||
    !RUNNER_UPDATE_VERSION.test(manifest.version) ||
    !("os" in manifest) ||
    manifest.os !== "linux" ||
    !("arch" in manifest) ||
    (manifest.arch !== "x64" && manifest.arch !== "arm64") ||
    !("sha256" in manifest) ||
    typeof manifest.sha256 !== "string" ||
    !RUNNER_UPDATE_DIGEST.test(manifest.sha256)
  )
    throw new Error("Invalid runner update manifest");

  const validated: RunnerUpdateManifest = {
    version: manifest.version,
    os: manifest.os,
    arch: manifest.arch,
    sha256: manifest.sha256,
  };
  const bytes = canonicalRunnerManifest(validated);
  for (const entry of envelope.signatures) {
    if (
      !entry ||
      typeof entry.keyId !== "string" ||
      !RUNNER_UPDATE_KEY_ID.test(entry.keyId) ||
      typeof entry.signature !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(entry.signature)
    )
      continue;
    const configured = keys.get(entry.keyId);
    if (!configured) continue;
    const key =
      typeof configured === "string" ? createPublicKey(configured) : configured;
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") continue;
    if (verify(null, bytes, key, Buffer.from(entry.signature, "base64")))
      return validated;
  }
  throw new Error("Runner update manifest has no valid trusted signature");
}
