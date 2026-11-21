import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cache from "../src/release-tarball-cache.js";
import { registerRunnerArtifacts } from "../src/routes/runner-artifacts.js";
import * as releases from "../src/server/release-helpers.js";
import * as commands from "../src/shared/lib/run-command.js";
import * as files from "../src/update-recovery/files.js";

const revision = "123456abcdef";
const version = "1.2.3";
const tag = `v${version}`;
const url = `/api/v1/runner-artifacts/${revision}`;
const descriptor = `${url}/descriptor.json`;
const bootstrapName = "install-dispatch-runner.sh";
const archiveName = cache.RELEASE_ARTIFACT_NAME;
const archiveBundle = `${archiveName}.sigstore.json`;
const bootstrapBundle = `${bootstrapName}.sigstore.json`;
const bootstrap = "#!/bin/bash\necho runner fixture\n";
const digest = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

let temp: string;
let inputs: string;
let source: string;
let app: FastifyInstance;

async function buildFixture(options?: {
  revision?: string;
  omitArm64?: boolean;
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
  for (const arch of options?.omitArm64 ? ["x64"] : ["x64", "arm64"]) {
    await writeFile(
      path.join(source, "dist/bun", `dispatch-${version}-bun-linux-${arch}`),
      arch
    );
  }
  await commands.runCommand(
    "tar",
    ["czf", path.join(inputs, archiveName), "dist", "bin"],
    {
      cwd: source,
    }
  );
}

function start(compiled = false) {
  registerRunnerArtifacts(app, { revision, version, compiled });
}

async function seedRelease() {
  const archive = cache.cachedTarballPath(tag);
  const companions = path.join(path.dirname(archive), `runner-${tag}`);
  await mkdir(companions, { recursive: true });
  await copyFile(path.join(inputs, archiveName), archive);
  await copyFile(
    path.join(inputs, bootstrapName),
    path.join(companions, bootstrapName)
  );
  for (const bundle of [bootstrapBundle, archiveBundle])
    await writeFile(path.join(companions, bundle), "{}\n");
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

  it("describes dev files and streams the aggregate with its length and digest", async () => {
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
      platforms: ["linux/x64", "linux/arm64"],
      files: {
        [bootstrapName]: {
          size: Buffer.byteLength(bootstrap),
          sha256: digest(bootstrap),
        },
        [archiveName]: { size, sha256 },
      },
    });
    expect((await app.inject(`${url}/${bootstrapName}`)).body).toBe(bootstrap);
    expect((await app.inject(`${url}/${archiveBundle}`)).statusCode).toBe(404);
  });

  it("rejects a different revision before any source work", async () => {
    await buildFixture();
    vi.stubEnv("DISPATCH_RUNNER_ARTIFACT_DEV_DIR", inputs);
    start();
    const response = await app.inject(
      "/api/v1/runner-artifacts/deadbeef/descriptor.json"
    );
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toContain("running revision");
  });

  it.each([
    [`${url}/package.json`, "unknown file"],
    [`${url}/descriptor%2ejson`, "percent-encoded alias"],
    [`${url}/..%2fpackage.json`, "encoded traversal"],
    [
      `/api/v1/runner-artifacts/${revision.toUpperCase()}/descriptor.json`,
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
  });

  it("rejects an aggregate missing one of the advertised platforms", async () => {
    await buildFixture({ omitArm64: true });
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
      [bootstrapName, bootstrapBundle, archiveName, archiveBundle].sort()
    );
    for (const bundle of [bootstrapBundle, archiveBundle]) {
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
        artifactSha256: archiveSha256,
        url: "",
        publishedAt: "",
      });
    const archive = vi
      .spyOn(cache, "ensureCachedTarball")
      .mockImplementation(async () => {
        const file = cache.cachedTarballPath(tag);
        await mkdir(path.dirname(file), { recursive: true });
        await copyFile(path.join(inputs, archiveName), file);
        return { tag, path: file, bytes: 1 };
      });
    const companion = vi
      .spyOn(cache, "downloadReleaseCompanion")
      .mockImplementation(async ({ name, destination }) => {
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(
          destination,
          name === bootstrapName ? bootstrap : "{}\n"
        );
      });
    start(true);
    const pending = await Promise.all(
      [descriptor, `${url}/${archiveName}`, `${url}/${bootstrapName}`].map(
        (path) => app.inject(path)
      )
    );
    expect(pending.map((response) => response.statusCode)).toEqual([
      200, 200, 200,
    ]);
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(archive).toHaveBeenCalledTimes(1);
    expect(companion.mock.calls.map(([asset]) => asset.name).sort()).toEqual(
      [bootstrapName, bootstrapBundle, archiveBundle].sort()
    );
  });

  it("serves no artifact when provenance verification fails", async () => {
    await buildFixture();
    await seedRelease();
    mockAttestations("signature verification failed");
    start(true);
    for (const target of [descriptor, `${url}/${archiveName}`]) {
      const response = await app.inject(target);
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toContain("verified");
    }
  });

  it("keeps rejecting a cache fill whose archive differs from the published digest", async () => {
    await buildFixture();
    await seedRelease();
    const archive = cache.cachedTarballPath(tag);
    await rm(path.join(path.dirname(archive), `runner-${tag}`, archiveBundle));
    vi.spyOn(releases, "fetchReleaseMetadata").mockResolvedValue({
      tag,
      artifactSha256: digest("other bytes"),
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
  });

  it("invalidates the descriptor and download after a verified archive is replaced", async () => {
    await buildFixture();
    await seedRelease();
    mockAttestations();
    start(true);
    expect((await app.inject(descriptor)).statusCode).toBe(200);
    await writeFile(cache.cachedTarballPath(tag), "replacement bytes");
    expect((await app.inject(descriptor)).statusCode).toBe(503);
    expect((await app.inject(`${url}/${archiveName}`)).statusCode).toBe(503);
  });

  it("rejects an attested aggregate from a different build of the same version", async () => {
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
    expect((await app.inject(descriptor)).statusCode).toBe(503);
  });
});
