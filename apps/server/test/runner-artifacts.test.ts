import { get } from "node:http";
import * as fs from "node:fs/promises";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  lstat,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as keys from "../src/agents/remote/update-keys.js";
import {
  canonicalRunnerManifest,
  runnerManifestName,
} from "../src/agents/remote/update-manifest.js";
import * as devKeys from "../src/server/runner-dev-key.js";
import * as cache from "../src/release-tarball-cache.js";
import { registerRunnerArtifacts } from "../src/routes/runner-artifacts.js";
import { registerRunnerInstaller } from "../src/routes/runner-installer.js";
import * as releases from "../src/server/release-helpers.js";
import * as commands from "../src/shared/lib/run-command.js";
import * as files from "../src/update-recovery/files.js";

vi.mock("node:fs/promises", { spy: true });

const revision = "123456abcdef";
const version = "1.2.3";
const tag = `v${version}`;
const url = `/api/v1/runner-artifacts/${revision}`;
const descriptor = `${url}/descriptor-linux-x64.json`;
const bootstrapName = "install-dispatch-runner.sh";
const bootstrapRoute = "install-dispatch-runner-linux-x64.sh";
const bootstrapBundleRoute = `${bootstrapRoute}.sigstore.json`;
const archiveName = "dispatch-runner-linux-x64.tar.gz";
const archiveBundle = `${archiveName}.sigstore.json`;
const bootstrapBundle = `${bootstrapName}.sigstore.json`;
const bootstrap = "#!/bin/bash\necho runner fixture\n";
const digest = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

function releaseAssets(sha256: string) {
  return [bootstrapName, bootstrapBundle, archiveName, archiveBundle].map(
    (name) => ({ name, digest: `sha256:${sha256}` })
  );
}

let temp: string;
let inputs: string;
let source: string;
let app: FastifyInstance;

async function buildFixture(options?: {
  revision?: string;
  includeArm64?: boolean;
  wrongArch?: boolean;
  binary?: string | Buffer;
}) {
  await mkdir(path.join(source, "dist/bun"), { recursive: true });
  await mkdir(path.join(source, "bin"), { recursive: true });
  await mkdir(inputs, { recursive: true });
  await writeFile(path.join(inputs, bootstrapName), bootstrap);
  await writeFile(path.join(source, "bin", bootstrapName), bootstrap);
  await writeFile(
    path.join(source, "dist/bun/BUILD_IDENTITY.json"),
    JSON.stringify({
      revision: options?.revision ?? revision,
      version,
    })
  );
  const members = [`bin/${bootstrapName}`, "dist/bun/BUILD_IDENTITY.json"];
  for (const helper of [
    "bin/dispatch-runner",
    "bin/dispatch-runner.service",
    "bin/dispatch-runner-update@.service",
    "bin/runner-handoff-v1.py",
  ]) {
    await writeFile(path.join(source, helper), "fixture");
    members.push(helper);
  }
  for (const arch of options?.includeArm64
    ? ["x64", "arm64"]
    : [options?.wrongArch ? "arm64" : "x64"]) {
    const binary = `dist/bun/dispatch-${version}-bun-linux-${arch}`;
    await writeFile(path.join(source, binary), options?.binary ?? arch);
    members.push(binary);
  }
  await commands.runCommand(
    "tar",
    ["czf", path.join(inputs, archiveName), ...members],
    { cwd: source }
  );
}

function start(compiled = false, now?: () => number) {
  return registerRunnerArtifacts(app, { revision, version, compiled }, now);
}

async function seedRelease() {
  const archive = cache.cachedTarballPath(tag);
  const companions = path.join(path.dirname(archive), `runner-${tag}`);
  await mkdir(companions, { recursive: true });
  await copyFile(
    path.join(inputs, archiveName),
    path.join(companions, archiveName)
  );
  await copyFile(
    path.join(inputs, bootstrapName),
    path.join(companions, bootstrapName)
  );
  for (const bundle of [bootstrapBundle, archiveBundle])
    await writeFile(path.join(companions, bundle), "{}\n");
  return companions;
}

function mockAttestations(verificationError?: string) {
  const original = commands.runCommand;
  return vi
    .spyOn(commands, "runCommand")
    .mockImplementation((cmd, args, options) => {
      if (cmd !== "gh") return original(cmd, args, options);
      if (verificationError)
        return Promise.reject(new Error(verificationError));
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    });
}

beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), "dispatch-runner-artifacts-"));
  inputs = path.join(temp, "input");
  source = path.join(temp, "archive-root");
  app = Fastify();
  vi.stubEnv("DISPATCH_RUNNER_ARTIFACT_DEV_DIR", undefined);
  vi.stubEnv("DISPATCH_RUNNER_ARTIFACT_TRUST_ROOT", undefined);
  vi.stubEnv("DISPATCH_RELEASE_CACHE_DIR", path.join(temp, "cache"));
  vi.stubEnv("DISPATCH_GITHUB_REPO", "selfcontained/dispatch");
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(temp, { recursive: true, force: true });
});

describe("runner artifact routes", () => {
  it("keeps source builds disabled until the dev directory is explicitly set", async () => {
    start();
    const response = await app.inject(descriptor);
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toContain("disabled");
  });

  it("describes dev files and streams the requested native payload with its length and digest", async () => {
    await buildFixture();
    vi.stubEnv("DISPATCH_RUNNER_ARTIFACT_DEV_DIR", inputs);
    start();
    const result = await app.inject(descriptor);
    expect(result.statusCode).toBe(200);
    const streamed = await app.inject(`${url}/${archiveName}`);
    expect(streamed.statusCode).toBe(200);
    const size = streamed.rawPayload.length;
    const sha256 = digest(streamed.rawPayload);
    expect(sha256).toBe(
      await files.hashRegular(path.join(inputs, archiveName))
    );
    expect(streamed.headers["content-length"]).toBe(String(size));
    expect(streamed.headers["repr-digest"]).toBe(
      `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`
    );
    expect(streamed.headers["content-type"]).toBe("application/gzip");
    expect(streamed.headers["cache-control"]).toBe("no-store");
    const head = await app.inject({
      method: "HEAD",
      url: `${url}/${archiveName}`,
    });
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe(String(size));
    expect(head.headers["repr-digest"]).toBe(streamed.headers["repr-digest"]);
    expect(head.rawPayload).toHaveLength(0);
    expect(result.json()).toEqual({
      revision,
      version,
      source: "dev",
      verified: false,
      platforms: ["linux/x64"],
      files: {
        [bootstrapRoute]: {
          size: Buffer.byteLength(bootstrap),
          sha256: digest(bootstrap),
        },
        [archiveName]: { size, sha256 },
      },
    });
    expect((await app.inject(`${url}/${bootstrapRoute}`)).body).toBe(bootstrap);
    expect((await app.inject(`${url}/${archiveBundle}`)).statusCode).toBe(404);
  });

  it("rejects a different revision before any source work", async () => {
    await buildFixture();
    vi.stubEnv("DISPATCH_RUNNER_ARTIFACT_DEV_DIR", inputs);
    start();
    const response = await app.inject(
      "/api/v1/runner-artifacts/deadbeef/descriptor-linux-x64.json"
    );
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toContain("running revision");
  });

  it.each([
    [`${url}/package.json`, "unknown file"],
    [`${url}/descriptor-linux-x64%2ejson`, "percent-encoded alias"],
    [`${url}/..%2fpackage.json`, "encoded traversal"],
    [
      `/api/v1/runner-artifacts/${revision.toUpperCase()}/descriptor-linux-x64.json`,
      "uppercase revision",
    ],
    [`${url}/linux/arm64/${archiveName}`, "extra path components"],
  ])("rejects %s (%s)", async (invalid, reason) => {
    await buildFixture();
    vi.stubEnv("DISPATCH_RUNNER_ARTIFACT_DEV_DIR", inputs);
    start();
    const response = await app.inject(invalid);
    expect(response.statusCode).toBe(404);
    if (reason !== "extra path components")
      expect(response.json().error).toBe("Invalid runner artifact path.");
  });

  it("rejects a dev artifact symlink even when it points to the correct bytes", async () => {
    await buildFixture();
    const file = path.join(inputs, bootstrapName);
    await rename(file, `${file}.target`);
    await symlink(`${file}.target`, file);
    const hash = vi.spyOn(files, "hashRegular");
    vi.stubEnv("DISPATCH_RUNNER_ARTIFACT_DEV_DIR", inputs);
    start();
    expect((await app.inject(descriptor)).statusCode).toBe(503);
    expect(hash).not.toHaveBeenCalledWith(file);
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
  });

  it("rejects a payload containing a second platform", async () => {
    await buildFixture({ includeArm64: true });
    vi.stubEnv("DISPATCH_RUNNER_ARTIFACT_DEV_DIR", inputs);
    start();
    expect((await app.inject(descriptor)).statusCode).toBe(503);
  });

  it("rejects an arm64 binary in an x64 payload", async () => {
    await buildFixture({ wrongArch: true });
    vi.stubEnv("DISPATCH_RUNNER_ARTIFACT_DEV_DIR", inputs);
    start();
    expect((await app.inject(descriptor)).statusCode).toBe(503);
  });

  it("uses a verified preseeded cache without fetching and serves both bundles", async () => {
    await buildFixture();
    await seedRelease();
    const gh = mockAttestations();
    const unexpectedFetch = new Error(
      "Preseeded release tried to use the network"
    );
    const metadata = vi
      .spyOn(releases, "fetchReleaseMetadata")
      .mockRejectedValue(unexpectedFetch);
    const archive = vi
      .spyOn(cache, "ensureCachedTarball")
      .mockRejectedValue(unexpectedFetch);
    const companion = vi
      .spyOn(cache, "downloadReleaseCompanion")
      .mockRejectedValue(unexpectedFetch);
    const root = path.join(temp, "root.jsonl");
    vi.stubEnv("DISPATCH_RUNNER_ARTIFACT_TRUST_ROOT", root);
    start(true);
    const result = await app.inject(descriptor);
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      source: "release",
      verified: true,
      revision,
      version,
    });
    expect(Object.keys(result.json().files).sort()).toEqual(
      [bootstrapRoute, bootstrapBundleRoute, archiveName, archiveBundle].sort()
    );
    for (const bundle of [bootstrapBundleRoute, archiveBundle]) {
      const response = await app.inject(`${url}/${bundle}`);
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("{}\n");
    }
    expect(metadata).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect(companion).not.toHaveBeenCalled();
    const verifications = gh.mock.calls.filter(([cmd]) => cmd === "gh");
    expect(verifications).toHaveLength(2);
    for (const [, args] of verifications)
      expect(args).toEqual(
        expect.arrayContaining([
          "--bundle",
          "--custom-trusted-root",
          root,
          "--repo",
          "selfcontained/dispatch",
          "--signer-workflow",
          "selfcontained/dispatch/.github/workflows/release.yml",
        ])
      );
  });

  it("coalesces concurrent cache misses into one fetch per asset", async () => {
    await buildFixture();
    const archiveSha256 = await files.hashRegular(
      path.join(inputs, archiveName)
    );
    mockAttestations();
    const metadata = vi
      .spyOn(releases, "fetchReleaseMetadata")
      .mockResolvedValue({
        tag,
        assets: releaseAssets(archiveSha256),
        url: "",
        publishedAt: "",
      });
    const archive = vi.spyOn(cache, "ensureCachedTarball");
    const companion = vi
      .spyOn(cache, "downloadReleaseCompanion")
      .mockImplementation(async ({ name, destination }) => {
        await mkdir(path.dirname(destination), { recursive: true });
        if (name === archiveName)
          await copyFile(path.join(inputs, name), destination);
        else
          await writeFile(
            destination,
            name === bootstrapName ? bootstrap : "{}\n"
          );
      });
    start(true);
    const pending = await Promise.all(
      [descriptor, `${url}/${archiveName}`, `${url}/${bootstrapRoute}`].map(
        (path) => app.inject(path)
      )
    );
    expect(pending.map((response) => response.statusCode)).toEqual([
      200, 200, 200,
    ]);
    expect(metadata).toHaveBeenCalledTimes(2);
    expect(archive).not.toHaveBeenCalled();
    expect(companion.mock.calls.map(([asset]) => asset.name).sort()).toEqual(
      [bootstrapName, bootstrapBundle, archiveName, archiveBundle].sort()
    );
  });

  it("serves no artifact when provenance verification fails", async () => {
    await buildFixture();
    await seedRelease();
    const gh = mockAttestations();
    const verify = gh.getMockImplementation()!;
    gh.mockImplementation((cmd, args, options) =>
      cmd === "gh" && args[2]?.endsWith(archiveName)
        ? Promise.reject(new Error("signature verification failed"))
        : verify(cmd, args, options)
    );
    start(true);
    for (const target of [descriptor, `${url}/${archiveName}`]) {
      const response = await app.inject(target);
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toContain("verified");
    }
    const archive = cache.cachedTarballPath(tag);
    const companions = path.join(path.dirname(archive), `runner-${tag}`);
    await expect(
      lstat(path.join(companions, archiveName))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(path.join(companions, archiveBundle))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps rejecting a cache fill whose archive differs from the published digest", async () => {
    await buildFixture();
    await seedRelease();
    const archive = path.join(
      path.dirname(cache.cachedTarballPath(tag)),
      `runner-${tag}`,
      archiveName
    );
    await rm(path.join(path.dirname(archive), archiveBundle));
    vi.spyOn(releases, "fetchReleaseMetadata").mockResolvedValue({
      tag,
      assets: releaseAssets(digest("other bytes")),
      url: "",
      publishedAt: "",
    });
    vi.spyOn(cache, "downloadReleaseCompanion").mockImplementation(
      async ({ destination }) => {
        await writeFile(destination, "{}\n");
      }
    );
    mockAttestations();
    start(true);
    expect((await app.inject(descriptor)).statusCode).toBe(503);
    expect((await app.inject(`${url}/${archiveName}`)).statusCode).toBe(503);
    await expect(lstat(archive)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an architecture-specific failure from disabling the shared installer and retries after 60 seconds", async () => {
    let now = 0;
    await buildFixture();
    await seedRelease();
    const companions = path.join(
      path.dirname(cache.cachedTarballPath(tag)),
      `runner-${tag}`
    );
    const malformed = path.join(companions, archiveBundle);
    await rm(malformed);
    const outside = path.join(inputs, "keep");
    await writeFile(outside, "{}");
    await symlink(outside, malformed);
    const archiveSha256 = await files.hashRegular(
      path.join(companions, archiveName)
    );
    mockAttestations();
    vi.spyOn(releases, "fetchReleaseMetadata").mockResolvedValue({
      tag,
      assets: releaseAssets(archiveSha256),
      url: "",
      publishedAt: "",
    });
    const download = vi
      .spyOn(cache, "downloadReleaseCompanion")
      .mockImplementation(async ({ destination }) => {
        await writeFile(destination, "{}");
      });
    const artifacts = start(true, () => now);
    registerRunnerInstaller(app, {
      artifacts,
      build: { revision, version },
      runners: {
        artifactEndpoint: async () => ({
          origin: "https://runner.test",
          pin: "A".repeat(43) + "=",
        }),
        listenerInstall: () => undefined,
      },
    });
    expect((await app.inject(descriptor)).statusCode).toBe(503);
    await expect(lstat(malformed)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(outside)).isFile()).toBe(true);
    expect(
      (await app.inject("/api/v1/runners/installer")).json().command
    ).toBeTruthy();
    now = 59_999;
    expect((await app.inject(descriptor)).statusCode).toBe(503);
    expect(download).not.toHaveBeenCalled();
    now = 60_000;
    expect((await app.inject(descriptor)).statusCode).toBe(200);
    expect(download).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({ destination: malformed })
    );
  });

  it("refuses to download a native release payload with no published digest", async () => {
    vi.spyOn(releases, "fetchReleaseMetadata").mockResolvedValue({
      tag,
      assets: releaseAssets(digest("native")).map(({ name }) => ({ name })),
      url: "",
      publishedAt: "",
    });
    const download = vi
      .spyOn(cache, "downloadReleaseCompanion")
      .mockRejectedValue(new Error("unexpected download"));
    start(true);
    expect((await app.inject(`${url}/${archiveName}`)).statusCode).toBe(503);
    expect(download).not.toHaveBeenCalled();
  });

  it("clearly refuses older releases without downloading their aggregate", async () => {
    vi.spyOn(releases, "fetchReleaseMetadata").mockResolvedValue({
      tag,
      assets: releaseAssets(digest("aggregate"))
        .filter(({ name }) => name !== archiveName && name !== archiveBundle)
        .concat([
          {
            name: cache.RELEASE_ARTIFACT_NAME,
            digest: "sha256:" + digest("aggregate"),
          },
        ]),
      url: "",
      publishedAt: "",
    });
    const download = vi.spyOn(cache, "downloadReleaseCompanion");
    start(true);
    const response = await app.inject(`${url}/${archiveName}`);
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toContain(
      "Upgrade the controller to a release with native runner payloads"
    );
    expect(download).not.toHaveBeenCalled();
  });

  it("never follows a release companion directory symlink during repair", async () => {
    await buildFixture();
    await seedRelease();
    const companions = path.join(
      path.dirname(cache.cachedTarballPath(tag)),
      `runner-${tag}`
    );
    const outside = path.join(temp, "outside-companions");
    await rename(companions, outside);
    await symlink(outside, companions);
    const attest = mockAttestations("fixture invalid attestation");
    start(true, () => 0);
    expect((await app.inject(descriptor)).statusCode).toBe(503);
    expect(attest.mock.calls).toEqual([]);
    await expect(lstat(companions)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(path.join(outside, bootstrapName))).isFile()).toBe(
      true
    );
  });

  it("invalidates the descriptor and download after a verified archive is replaced", async () => {
    await buildFixture();
    await seedRelease();
    mockAttestations();
    start(true);
    expect((await app.inject(descriptor)).statusCode).toBe(200);
    await writeFile(
      path.join(
        path.dirname(cache.cachedTarballPath(tag)),
        `runner-${tag}`,
        archiveName
      ),
      "replacement bytes"
    );
    expect((await app.inject(descriptor)).statusCode).toBe(503);
    expect((await app.inject(`${url}/${archiveName}`)).statusCode).toBe(503);
  });

  it("rejects an attested native payload from a different build of the same version", async () => {
    await buildFixture({ revision: "deadbeefcafe" });
    await seedRelease();
    mockAttestations();
    start(true);
    expect((await app.inject(descriptor)).statusCode).toBe(503);
  });

  it("rejects an attested bootstrap different from the archived script", async () => {
    await buildFixture();
    await writeFile(
      path.join(inputs, bootstrapName),
      "#!/bin/bash\necho other release\n"
    );
    await seedRelease();
    mockAttestations();
    start(true);
    expect((await app.inject(`${url}/${bootstrapRoute}`)).statusCode).toBe(503);
    expect((await app.inject(descriptor)).statusCode).toBe(503);
  });
});

describe("runner update artifacts", () => {
  const signer = generateKeyPairSync("ed25519");
  const sha256 = digest("x64");
  const update = `${url}/update/${version}/linux/x64/${sha256}`;
  const manifestUrl = `${update}/manifest.json`;
  const executableUrl = `${update}/dispatch-runner`;
  const manifestName = runnerManifestName("x64");
  const pem = signer.publicKey.export({ type: "spki", format: "pem" });

  async function signFixture(directory: string, keyId: string, fields = {}) {
    const manifest = {
      version,
      os: "linux",
      arch: "x64",
      sha256,
      ...fields,
    } as const;
    const signature = sign(
      null,
      canonicalRunnerManifest(manifest),
      signer.privateKey
    ).toString("base64");
    const envelope = { manifest, signatures: [{ keyId, signature }] };
    await writeFile(
      path.join(directory, manifestName),
      JSON.stringify(envelope)
    );
    return envelope;
  }

  function dev() {
    vi.stubEnv("DISPATCH_RUNNER_ARTIFACT_DEV_DIR", inputs);
    vi.spyOn(devKeys, "readRunnerDevPublicKey").mockResolvedValue(pem);
    start();
  }

  it("serves a preseeded release using local attested assets and signature verification", async () => {
    await buildFixture();
    const companions = await seedRelease();
    const envelope = await signFixture(companions, "fixture-release");
    vi.spyOn(keys, "productionRunnerUpdateKeys", "get").mockReturnValue(
      new Map([["fixture-release", pem]])
    );
    mockAttestations();
    const metadata = vi.spyOn(releases, "fetchReleaseMetadata");
    start(true);
    const manifest = await app.inject(manifestUrl);
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toEqual(envelope);
    const binary = await app.inject(executableUrl);
    expect(binary.statusCode).toBe(200);
    expect(digest(binary.rawPayload)).toBe(sha256);
    expect(metadata).not.toHaveBeenCalled();
    for (const resource of [manifestUrl, executableUrl]) {
      const head = await app.inject({ method: "HEAD", url: resource });
      expect(head.statusCode).toBe(200);
      expect(Number(head.headers["content-length"])).toBeGreaterThan(0);
      expect(head.rawPayload).toHaveLength(0);
    }
  });

  it("rejects an untrusted release signature even with an attested archive", async () => {
    await buildFixture();
    const companions = await seedRelease();
    await signFixture(companions, keys.RUNNER_UPDATE_DEV_KEY_ID);
    mockAttestations();
    start(true);
    expect((await app.inject(manifestUrl)).statusCode).toBe(503);
    expect((await app.inject(executableUrl)).statusCode).toBe(503);
  });

  it("evicts a truncated release envelope and refetches it after backoff", async () => {
    let now = 0;
    await buildFixture();
    const companions = await seedRelease();
    const envelope = await signFixture(companions, "fixture-release");
    const cached = path.join(companions, manifestName);
    await writeFile(cached, '{"manifest":');
    vi.spyOn(keys, "productionRunnerUpdateKeys", "get").mockReturnValue(
      new Map([["fixture-release", pem]])
    );
    mockAttestations();
    vi.spyOn(releases, "fetchReleaseMetadata").mockResolvedValue({
      tag,
      assets: [{ name: manifestName }],
      url: "",
      publishedAt: "",
    });
    const download = vi
      .spyOn(cache, "downloadReleaseCompanion")
      .mockImplementation(async ({ destination }) => {
        expect(destination).toBe(cached);
        await writeFile(destination, JSON.stringify(envelope));
      });
    start(true, () => now);
    expect((await app.inject(manifestUrl)).statusCode).toBe(503);
    await expect(lstat(cached)).rejects.toMatchObject({ code: "ENOENT" });
    expect(download).not.toHaveBeenCalled();
    now = 60_000;
    const response = await app.inject(manifestUrl);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(envelope);
    expect(download).toHaveBeenCalledOnce();
  });

  it("rejects release update requests when the signed companion is absent", async () => {
    await buildFixture();
    await seedRelease();
    mockAttestations();
    vi.spyOn(releases, "fetchReleaseMetadata").mockResolvedValue(null);
    start(true);
    expect((await app.inject(manifestUrl)).statusCode).toBe(404);
    expect((await app.inject(executableUrl)).statusCode).toBe(404);
    expect((await app.inject(`${url}/${archiveName}`)).statusCode).toBe(200);
  });

  it("requires dev compilation for a compiled controller to serve dev updates", async () => {
    await buildFixture();
    await signFixture(inputs, keys.RUNNER_UPDATE_DEV_KEY_ID);
    vi.stubEnv("DISPATCH_RUNNER_ARTIFACT_DEV_DIR", inputs);
    vi.spyOn(devKeys, "readRunnerDevPublicKey").mockResolvedValue(pem);
    start(true);
    expect((await app.inject(manifestUrl)).statusCode).toBe(404);
  });

  it.each([
    ["altered executable bytes", { binary: "x65" }, {}],
    ["archive revision skew", { revision: "abcdef123456" }, {}],
    ["signed version skew", {}, { version: "1.2.4" }],
    ["signed platform skew", {}, { arch: "arm64" }],
  ])("rejects both files for %s", async (_case, archive, fields) => {
    await buildFixture(archive);
    await signFixture(inputs, keys.RUNNER_UPDATE_DEV_KEY_ID, fields);
    dev();
    expect((await app.inject(manifestUrl)).statusCode).toBe(503);
    expect((await app.inject(executableUrl)).statusCode).toBe(503);
  });

  it("requires an exact path, controller revision, version and signed digest", async () => {
    await buildFixture();
    await signFixture(inputs, keys.RUNNER_UPDATE_DEV_KEY_ID);
    dev();
    expect((await app.inject(executableUrl)).body).toBe("x64");
    for (const invalid of [
      manifestUrl.replace(revision, "deadbeef"),
      manifestUrl.replace(version, "9.9.9"),
      manifestUrl.replace(sha256, "a".repeat(64)),
      manifestUrl.replace("manifest.json", "manifest%2ejson"),
      manifestUrl + "?alias",
    ])
      expect((await app.inject(invalid)).statusCode, invalid).toBe(404);
  });

  it("serves the root updater's revision-free route and a gzip body", async () => {
    await buildFixture();
    const envelope = await signFixture(inputs, keys.RUNNER_UPDATE_DEV_KEY_ID);
    dev();
    const bare = `/api/v1/runner-artifacts/update/${version}/linux/x64/${sha256}`;
    expect((await app.inject(`${bare}/manifest.json`)).json()).toEqual(
      envelope
    );
    expect((await app.inject(`${bare}/dispatch-runner`)).body).toBe("x64");
    const cached = path.join(inputs, `runner-${revision}-x64-${sha256}.gz`);
    await expect(lstat(cached)).rejects.toMatchObject({ code: "ENOENT" });
    const gzipRequests = await Promise.all(
      [bare, update].map((base) => app.inject(`${base}/dispatch-runner.gz`))
    );
    expect(
      vi
        .mocked(fs.mkdtemp)
        .mock.calls.filter(([prefix]) =>
          String(prefix).endsWith(".runner-gzip-")
        )
    ).toHaveLength(1);
    const first = await lstat(cached);
    for (const response of gzipRequests) {
      expect(response.headers["content-length"]).toBe(String(first.size));
    }
    for (const base of [bare, update]) {
      const compressed = await app.inject(`${base}/dispatch-runner.gz`);
      expect(compressed.statusCode).toBe(200);
      expect(compressed.headers["content-type"]).toBe("application/gzip");
      expect(compressed.headers["content-encoding"]).toBeUndefined();
      expect(gunzipSync(compressed.rawPayload).toString()).toBe("x64");
      const head = await app.inject({
        method: "HEAD",
        url: `${base}/dispatch-runner.gz`,
      });
      expect([head.statusCode, head.rawPayload.length]).toEqual([200, 0]);
      expect(head.headers["content-length"]).toBe(String(first.size));
      expect((await lstat(cached)).ino).toBe(first.ino);
    }
    for (const invalid of [
      `${bare.replace(version, "9.9.9")}/dispatch-runner.gz`,
      `${bare.replace(sha256, "a".repeat(64))}/dispatch-runner.gz`,
      `${bare}/dispatch-runner.tar.gz`,
      `${bare}/dispatch-runner.gz?alias`,
    ])
      expect((await app.inject(invalid)).statusCode, invalid).toBe(404);
  });

  it("closes the gzip file handle when an HTTP client aborts", async () => {
    const binary = randomBytes(8 * 1024 * 1024);
    const sha256 = digest(binary);
    await buildFixture({ binary });
    await signFixture(inputs, keys.RUNNER_UPDATE_DEV_KEY_ID, { sha256 });
    dev();
    const gzipUrl = `${update.replace(digest("x64"), sha256)}/dispatch-runner.gz`;
    expect(
      (await app.inject({ method: "HEAD", url: gzipUrl })).statusCode
    ).toBe(200);

    const { open: original } =
      await vi.importActual<typeof fs>("node:fs/promises");
    let served: Awaited<ReturnType<typeof original>> | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith(".gz")) served = handle;
      return handle;
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      get(address + gzipUrl, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Unexpected HTTP status ${response.statusCode}`));
          return;
        }
        response.once("data", () => {
          response.destroy();
          resolve();
        });
      }).once("error", reject);
    });
    await vi.waitFor(() => expect(served?.fd).toBe(-1));
  });

  it("rejects a changed cached executable before serving either file", async () => {
    await buildFixture();
    await signFixture(inputs, keys.RUNNER_UPDATE_DEV_KEY_ID);
    dev();
    expect((await app.inject(`${update}/dispatch-runner.gz`)).statusCode).toBe(
      200
    );
    const executable = path.join(inputs, `runner-${revision}-x64-${sha256}`);
    await writeFile(executable, "x65");
    expect((await app.inject(manifestUrl)).statusCode).toBe(503);
    expect((await app.inject(executableUrl)).statusCode).toBe(503);
    await expect(lstat(executable + ".gz")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
