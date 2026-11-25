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
export function canonicalManifestBytes({
  version,
  os,
  arch,
  sha256,
}: RunnerUpdateManifest) {
  return new TextEncoder().encode(
    JSON.stringify({ version, os, arch, sha256 })
  );
}

export function verifySignedManifest<Key>(
  envelope: unknown,
  keys: ReadonlyMap<string, Key>,
  verifySignature: (
    key: Key,
    bytes: Uint8Array,
    signature: Uint8Array
  ) => boolean
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
  const bytes = canonicalManifestBytes(validated);
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
    const signature = Uint8Array.from(atob(entry.signature), (c) =>
      c.charCodeAt(0)
    );
    if (
      signature.length === 64 &&
      verifySignature(configured, bytes, signature)
    )
      return validated;
  }
  throw new Error("Runner update manifest has no valid trusted signature");
}

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
function compareIdentifiers(left: string, right: string) {
  const leftNumeric = /^[0-9]+$/.test(left);
  const rightNumeric = /^[0-9]+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const a = left.replace(/^0+(?=.)/, "");
    const b = right.replace(/^0+(?=.)/, "");
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/** SemVer precedence. A release outranks its prereleases. */
export function compareRunnerVersions(left: string, right: string) {
  if (!RUNNER_UPDATE_VERSION.test(left) || !RUNNER_UPDATE_VERSION.test(right))
    throw new Error("Invalid runner version");
  const split = (value: string) => {
    const dash = value.indexOf("-");
    return dash < 0
      ? { core: value.split("."), pre: [] as string[] }
      : {
          core: value.slice(0, dash).split("."),
          pre: value.slice(dash + 1).split("."),
        };
  };
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < 3; index++) {
    const order = compareIdentifiers(a.core[index]!, b.core[index]!);
    if (order) return order;
  }
  if (!a.pre.length || !b.pre.length)
    return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    if (index >= a.pre.length) return -1;
    if (index >= b.pre.length) return 1;
    const order = compareIdentifiers(a.pre[index]!, b.pre[index]!);
    if (order) return order;
  }
  return 0;
}

// Provision the active and standby public keys here as [key ID, SPKI PEM] pairs.
// See docs/runner-update-signing.md.
export const productionRunnerUpdateKeys: ReadonlyMap<string, string> = new Map([
  // Active key slot.
  // Standby rotation key slot.
]);

export const RUNNER_UPDATE_DEV_KEY_ID = "dispatch-local-dev";
