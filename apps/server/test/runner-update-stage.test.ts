import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RUNNER_UPDATE_DEV_KEY_ID } from "../src/agents/remote/update-keys.js";
import { canonicalRunnerManifest } from "../src/agents/remote/update-manifest.js";
import {
  compareRunnerVersions,
  parseRunnerUpdateInstance,
  RunnerUpdateRefused,
  runnerUpdateInstance,
  stageRunnerUpdate,
  type RunnerUpdateLayout,
  type StageRunnerUpdateOptions,
} from "../src/agents/remote/update-verify.js";
import { issueAuthority, issueServer } from "../src/agents/remote/x509.js";

const active = generateKeyPairSync("ed25519");
const standby = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const keys = new Map([
  ["runner-a", active.publicKey],
  ["runner-b", standby.publicKey],
]);
const authority = issueAuthority("Fixture runner CA");
const leaf = issueServer(authority, ["127.0.0.1"]);

const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const installedBytes = Buffer.from("installed runner 1.2.3");
const payload = Buffer.from("candidate runner 1.3.0 ".repeat(4096));
const target = {
  version: "1.3.0",
  os: "linux",
  arch: "x64",
  sha256: sha(payload),
} as const;

function envelope(
  manifest: Record<string, string> = target,
  signer: { keyId: string; key: typeof active.privateKey }[] = [
    { keyId: "runner-a", key: active.privateKey },
  ]
) {
  return {
    manifest,
    signatures: signer.map(({ keyId, key }) => ({
      keyId,
      signature: sign(
        null,
        canonicalRunnerManifest(manifest as typeof target),
        key
      ).toString("base64"),
    })),
  };
}

type Handler = (
  file: string,
  response: import("node:http").ServerResponse
) => void;

let root: string;
let layout: RunnerUpdateLayout;
let server: https.Server;
let origin: string;
let requests: string[];
let handler: Handler;
let served: { envelope: unknown; body: Buffer };

function serveDefault(
  file: string,
  response: import("node:http").ServerResponse
) {
  if (file === "manifest.json") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(served.envelope));
  } else if (file === "dispatch-runner.gz") {
    response.writeHead(200, { "content-type": "application/gzip" });
    response.end(gzipSync(served.body));
  } else {
    response.writeHead(404).end();
  }
}

async function listing(directory: string) {
  return (await readdir(directory)).sort();
}

function options(
  overrides: Partial<StageRunnerUpdateOptions> = {}
): StageRunnerUpdateOptions {
  return {
    layout,
    keys,
    host: { os: "linux", arch: "x64" },
    installedVersion: "1.2.3",
    trustedUid: process.getuid!(),
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(RunnerUpdateRefused);
  return (error as RunnerUpdateRefused).reason;
}

async function writeSettings(endpoint: string, ca = layout.config) {
  await writeFile(
    layout.config,
    JSON.stringify({
      endpoint,
      ca: path.join(path.dirname(ca), "ca.pem"),
      state: "/var/lib/dispatch-runner/runner",
    }),
    { mode: 0o600 }
  );
  await chmod(layout.config, 0o600);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "runner-update-stage-"));
  layout = {
    config: path.join(root, "etc/runner.json"),
    installed: path.join(root, "opt/dispatch"),
    staging: path.join(root, "opt/update"),
    state: path.join(root, "var/update"),
  };
  await mkdir(path.join(root, "etc"), { mode: 0o711 });
  await chmod(path.join(root, "etc"), 0o711);
  await mkdir(path.join(root, "opt"), { mode: 0o755 });
  for (const directory of [layout.staging, layout.state]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  await writeFile(layout.installed, installedBytes, { mode: 0o755 });
  await writeFile(path.join(root, "etc/ca.pem"), authority.cert, {
    mode: 0o644,
  });
  requests = [];
  handler = serveDefault;
  served = { envelope: envelope(), body: payload };
  server = https.createServer(
    { cert: leaf.cert, key: leaf.key },
    (request, response) => {
      requests.push(request.url!);
      const prefix = `/api/v1/runner-artifacts/update/`;
      if (!request.url!.startsWith(prefix)) {
        response.writeHead(404).end();
        return;
      }
      handler(request.url!.split("/").at(-1)!, response);
    }
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await writeSettings(origin);
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

describe("runner update request", () => {
  it.each([
    "",
    "1.3.0_linux_x64",
    "1.3.0_linux_riscv64_" + "a".repeat(64),
    "1.3.0_darwin_x64_" + "a".repeat(64),
    "1.3.0_linux_x64_" + "A".repeat(64),
    "1.3.0_linux_x64_" + "a".repeat(63),
    "1.3_linux_x64_" + "a".repeat(64),
    "1.3.0+build_linux_x64_" + "a".repeat(64),
    "../1.3.0_linux_x64_" + "a".repeat(64),
    "1.3.0_linux_x64_" + "a".repeat(64) + " --flag",
    "1.3.0-" + "a".repeat(60) + "_linux_x64_" + "a".repeat(64),
  ])(
    "refuses malformed instance %j before any state is read",
    async (instance) => {
      await rm(layout.config);
      expect(await refusal(stageRunnerUpdate(instance, options()))).toBe(
        "invalid_request"
      );
      expect(requests).toEqual([]);
    }
  );

  it("round-trips a well-formed instance", () => {
    expect(parseRunnerUpdateInstance(runnerUpdateInstance(target))).toEqual(
      target
    );
    expect(
      parseRunnerUpdateInstance(`1.3.0-dev.4_linux_arm64_${"b".repeat(64)}`)
    ).toEqual({
      version: "1.3.0-dev.4",
      os: "linux",
      arch: "arm64",
      sha256: "b".repeat(64),
    });
  });

  it("orders versions by SemVer precedence", () => {
    const ordered = [
      "1.0.0-9",
      "1.0.0-2a",
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0-rc.2",
      "1.0.0-rc-10",
      "1.0.0-rc-2",
      "1.0.0-rc-9",
      "1.0.0",
      "1.0.9",
      "1.0.10",
      "1.10.0",
      "10.0.0",
      "99999999999999999999.0.0",
    ];
    for (let index = 1; index < ordered.length; index++) {
      expect(compareRunnerVersions(ordered[index - 1]!, ordered[index]!)).toBe(
        -1
      );
      expect(compareRunnerVersions(ordered[index]!, ordered[index - 1]!)).toBe(
        1
      );
    }
    expect(compareRunnerVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("runner update staging", () => {
  const instance = runnerUpdateInstance(target);

  it("stages a signed build privately without touching the installed runner", async () => {
    const before = await stat(layout.installed);
    const result = await stageRunnerUpdate(instance, options());
    expect(result.outcome).toBe("staged");
    const candidate = path.join(layout.staging, `dispatch-${target.sha256}`);
    expect(result.candidate).toBe(candidate);
    expect(sha(await readFile(candidate))).toBe(target.sha256);
    expect((await stat(candidate)).mode & 0o777).toBe(0o700);
    expect((await stat(candidate)).dev).toBe(before.dev);
    expect(await listing(layout.staging)).toEqual([
      `dispatch-${target.sha256}`,
      `dispatch-${target.sha256}.manifest.json`,
    ]);
    const after = await stat(layout.installed);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    expect(await readFile(layout.installed)).toEqual(installedBytes);
    // The floor starts at the installed build, independent of the controller.
    expect(
      JSON.parse(await readFile(path.join(layout.state, "floor.json"), "utf8"))
    ).toEqual({ version: "1.2.3", sha256: sha(installedBytes) });
    expect(requests).toEqual([
      `/api/v1/runner-artifacts/update/1.3.0/linux/x64/${target.sha256}/manifest.json`,
      `/api/v1/runner-artifacts/update/1.3.0/linux/x64/${target.sha256}/dispatch-runner.gz`,
    ]);

    // A second request re-verifies the candidate locally and fetches nothing.
    requests = [];
    expect((await stageRunnerUpdate(instance, options())).outcome).toBe(
      "already_staged"
    );
    expect(requests).toEqual([]);
  });

  it("accepts the standby key slot", async () => {
    served.envelope = envelope(target, [
      { keyId: "runner-b", key: standby.privateKey },
    ]);
    expect((await stageRunnerUpdate(instance, options())).outcome).toBe(
      "staged"
    );
  });

  it.each([
    ["unsigned", () => envelope(target, [])],
    [
      "an untrusted key",
      () => envelope(target, [{ keyId: "runner-a", key: stranger.privateKey }]),
    ],
    [
      "an unknown key ID",
      () => envelope(target, [{ keyId: "runner-c", key: active.privateKey }]),
    ],
    [
      "a signature over another digest",
      () => ({
        ...envelope({ ...target, sha256: "c".repeat(64) }),
        manifest: target,
      }),
    ],
  ])("refuses %s manifests", async (_name, build) => {
    served.envelope = build();
    expect(await refusal(stageRunnerUpdate(instance, options()))).toBe(
      "verify_failed"
    );
    expect(await listing(layout.staging)).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("refuses a development-signed manifest under production trust", async () => {
    const dev = generateKeyPairSync("ed25519");
    served.envelope = envelope(target, [
      { keyId: RUNNER_UPDATE_DEV_KEY_ID, key: dev.privateKey },
    ]);
    expect(await refusal(stageRunnerUpdate(instance, options()))).toBe(
      "verify_failed"
    );
    expect(
      (
        await stageRunnerUpdate(
          instance,
          options({
            keys: new Map([[RUNNER_UPDATE_DEV_KEY_ID, dev.publicKey]]),
          })
        )
      ).outcome
    ).toBe("staged");
  });

  it.each([
    ["version", { version: "1.4.0" }],
    ["architecture", { arch: "arm64" }],
    ["digest", { sha256: "d".repeat(64) }],
  ])(
    "refuses a validly signed manifest for another %s",
    async (_name, field) => {
      served.envelope = envelope({ ...target, ...field });
      expect(await refusal(stageRunnerUpdate(instance, options()))).toBe(
        "verify_failed"
      );
      expect(await listing(layout.staging)).toEqual([]);
    }
  );

  it("refuses a signed build other than the requested digest, even with matching bytes", async () => {
    const other = Buffer.from("another signed build");
    served = {
      envelope: envelope({ ...target, sha256: sha(other) }),
      body: other,
    };
    expect(await refusal(stageRunnerUpdate(instance, options()))).toBe(
      "verify_failed"
    );
    expect(await listing(layout.staging)).toEqual([]);
  });

  it("restages a candidate whose bytes changed after staging", async () => {
    await stageRunnerUpdate(instance, options());
    const candidate = path.join(layout.staging, `dispatch-${target.sha256}`);
    await writeFile(candidate, "altered");
    requests = [];
    expect((await stageRunnerUpdate(instance, options())).outcome).toBe(
      "staged"
    );
    expect(sha(await readFile(candidate))).toBe(target.sha256);
    expect(requests).toHaveLength(2);
  });

  it("refuses bytes that differ from the signed digest and keeps nothing", async () => {
    served.body = Buffer.concat([payload, Buffer.from("!")]);
    expect(await refusal(stageRunnerUpdate(instance, options()))).toBe(
      "verify_failed"
    );
    expect(await listing(layout.staging)).toEqual([]);
  });

  it("removes the partial download when the connection drops", async () => {
    handler = (file, response) => {
      if (file !== "dispatch-runner.gz") return serveDefault(file, response);
      const body = gzipSync(payload);
      response.writeHead(200, { "content-length": body.length });
      response.write(body.subarray(0, body.length >> 1), () =>
        response.socket?.destroy()
      );
    };
    expect(await refusal(stageRunnerUpdate(instance, options()))).toBe(
      "download_failed"
    );
    expect(await listing(layout.staging)).toEqual([]);
  });

  it("removes temporaries left by a dead updater", async () => {
    await writeFile(
      path.join(layout.staging, `.tmp-999999999-${"e".repeat(16)}`),
      "partial"
    );
    await writeFile(
      path.join(layout.staging, `dispatch-${"f".repeat(64)}`),
      "older candidate"
    );
    await stageRunnerUpdate(instance, options());
    expect(await listing(layout.staging)).toEqual([
      `dispatch-${target.sha256}`,
      `dispatch-${target.sha256}.manifest.json`,
    ]);
  });

  it.each([
    ["the installed version", { installedVersion: "1.3.1" }, "downgrade"],
    [
      "an equal installed version",
      { installedVersion: "1.3.0" },
      "version_conflict",
    ],
  ] as const)(
    "refuses below or beside %s before downloading",
    async (_name, override, reason) => {
      expect(
        await refusal(stageRunnerUpdate(instance, options(override)))
      ).toBe(reason);
      expect(requests).toEqual([]);
    }
  );

  it("keeps a persisted floor above the installed version", async () => {
    await writeFile(
      path.join(layout.state, "floor.json"),
      JSON.stringify({ version: "1.4.0", sha256: "a".repeat(64) }),
      { mode: 0o600 }
    );
    expect(await refusal(stageRunnerUpdate(instance, options()))).toBe(
      "downgrade"
    );
    await writeFile(
      path.join(layout.state, "floor.json"),
      JSON.stringify({ version: "1.3.0", sha256: "a".repeat(64) })
    );
    expect(await refusal(stageRunnerUpdate(instance, options()))).toBe(
      "version_conflict"
    );
    for (const damaged of [
      "{}",
      JSON.stringify({ version: "1.0.0", sha256: "short" }),
      JSON.stringify({ version: "latest", sha256: "a".repeat(64) }),
    ]) {
      await writeFile(path.join(layout.state, "floor.json"), damaged);
      expect(await refusal(stageRunnerUpdate(instance, options()))).toBe(
        "untrusted_state"
      );
    }
    expect(requests).toEqual([]);
  });

  it("names the floor in a refusal and never lowers it for an offer", async () => {
    const file = path.join(layout.state, "floor.json");
    const floor = JSON.stringify({ version: "1.4.0", sha256: "a".repeat(64) });
    await writeFile(file, floor, { mode: 0o600 });
    await expect(stageRunnerUpdate(instance, options())).rejects.toMatchObject({
      reason: "downgrade",
      floorVersion: "1.4.0",
      message: expect.stringContaining("confirmed floor 1.4.0"),
    });
    expect(await readFile(file, "utf8")).toBe(floor);
    const same = JSON.stringify({ version: "1.3.0", sha256: "a".repeat(64) });
    await writeFile(file, same);
    await expect(stageRunnerUpdate(instance, options())).rejects.toMatchObject({
      reason: "version_conflict",
      floorVersion: "1.3.0",
      message: expect.stringContaining("confirmed floor 1.3.0"),
    });
    expect(await readFile(file, "utf8")).toBe(same);
  });

  it("treats the installed digest as already installed", async () => {
    const result = await stageRunnerUpdate(
      runnerUpdateInstance({
        ...target,
        version: "1.2.3",
        sha256: sha(installedBytes),
      }),
      options()
    );
    expect(result.outcome).toBe("already_installed");
    expect(requests).toEqual([]);
  });

  it.each([
    ["an arm64 build on x64", "arm64", { os: "linux", arch: "x64" }],
    ["an x64 build on arm64", "x64", { os: "linux", arch: "arm64" }],
    ["a Linux build on macOS", "x64", { os: "darwin", arch: "x64" }],
    ["an unsupported host", "x64", { os: "linux", arch: "ia32" }],
  ] as const)("refuses %s", async (_name, arch, host) => {
    expect(
      await refusal(
        stageRunnerUpdate(
          runnerUpdateInstance({ ...target, arch }),
          options({ host })
        )
      )
    ).toBe("platform_mismatch");
    expect(requests).toEqual([]);
  });

  it("never follows a redirect, even to the same origin", async () => {
    for (const location of [
      "https://example.com/dispatch-runner.gz",
      `${origin}/api/v1/runner-artifacts/update/other`,
    ]) {
      handler = (file, response) => {
        if (file !== "dispatch-runner.gz") return serveDefault(file, response);
        // A body that would verify still never counts as the file.
        response.writeHead(302, { location }).end(gzipSync(payload));
      };
      requests = [];
      expect(await refusal(stageRunnerUpdate(instance, options()))).toBe(
        "download_failed"
      );
      expect(requests).toHaveLength(2);
      expect(await listing(layout.staging)).toEqual([]);
    }
  });

  it("refuses an unexpected content encoding", async () => {
    handler = (file, response) => {
      if (file !== "dispatch-runner.gz") return serveDefault(file, response);
      response
        .writeHead(200, { "content-encoding": "gzip" })
        .end(gzipSync(payload));
    };
    expect(await refusal(stageRunnerUpdate(instance, options()))).toBe(
      "download_failed"
    );
  });

  it("trusts only the enrolled CA", async () => {
    await writeFile(
      path.join(root, "etc/ca.pem"),
      issueAuthority("Other CA").cert
    );
    expect(await refusal(stageRunnerUpdate(instance, options()))).toBe(
      "download_failed"
    );
    expect(requests).toEqual([]);
  });

  it.each([
    [
      "a plain HTTP endpoint",
      async () => writeSettings(origin.replace("https:", "http:")),
    ],
    [
      "an endpoint with a path",
      async () => writeSettings(`${origin}/elsewhere`),
    ],
    [
      "an endpoint with credentials",
      async () => writeSettings(origin.replace("https://", "https://user:pw@")),
    ],
    ["an unenrolled runner", async () => writeFile(layout.config, "{}")],
    ["group-writable settings", async () => chmod(layout.config, 0o620)],
    [
      "a world-writable CA",
      async () => chmod(path.join(root, "etc/ca.pem"), 0o666),
    ],
    [
      "a symlinked CA",
      async () => {
        await rm(path.join(root, "etc/ca.pem"));
        await writeFile(path.join(root, "elsewhere.pem"), authority.cert);
        await symlink(
          path.join(root, "elsewhere.pem"),
          path.join(root, "etc/ca.pem")
        );
      },
    ],
    ["a shared staging directory", async () => chmod(layout.staging, 0o755)],
    ["a shared state directory", async () => chmod(layout.state, 0o750)],
    [
      "a symlinked staging directory",
      async () => {
        await rm(layout.staging, { recursive: true });
        await mkdir(path.join(root, "other"), { mode: 0o700 });
        await symlink(path.join(root, "other"), layout.staging);
      },
    ],
    ["a missing installed runner", async () => rm(layout.installed)],
  ])("refuses %s", async (_name, damage) => {
    await damage();
    expect(await refusal(stageRunnerUpdate(instance, options()))).toBe(
      "untrusted_state"
    );
    expect(requests).toEqual([]);
  });

  it("refuses state owned by another user", async () => {
    expect(
      await refusal(
        stageRunnerUpdate(
          instance,
          options({ trustedUid: process.getuid!() + 1 })
        )
      )
    ).toBe("untrusted_state");
  });

  it("keeps staging consistent under concurrent requests", async () => {
    const second = Buffer.from("candidate runner 1.4.0 ".repeat(4096));
    const other = { ...target, version: "1.4.0", sha256: sha(second) };
    handler = (file, response) => {
      const url = requests.at(-1)!;
      served = url.includes(other.sha256)
        ? { envelope: envelope(other), body: second }
        : { envelope: envelope(), body: payload };
      serveDefault(file, response);
    };
    const results = await Promise.allSettled([
      stageRunnerUpdate(instance, options()),
      stageRunnerUpdate(instance, options()),
      stageRunnerUpdate(runnerUpdateInstance(other), options()),
      stageRunnerUpdate(runnerUpdateInstance(other), options()),
    ]);
    // Every settled request either staged its own verified build or failed
    // cleanly; whatever remains verifies against its signed digest.
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toBeInstanceOf(RunnerUpdateRefused);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    const names = await listing(layout.staging);
    expect(names.filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    for (const name of names.filter((name) => !name.endsWith(".json")))
      expect(
        `dispatch-${sha(await readFile(path.join(layout.staging, name)))}`
      ).toBe(name);
    expect(await listing(layout.state)).toEqual(["floor.json"]);
  });
});
