import { generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  compiledRunnerUpdateKeys,
  RUNNER_UPDATE_DEV_KEY_ID,
} from "../../../packages/runner/src/workload/agents/remote/update-keys.js";
import {
  canonicalRunnerManifest,
  verifyRunnerUpdateEnvelope,
} from "../../../packages/runner/src/workload/agents/remote/update-manifest.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const standby = generateKeyPairSync("ed25519");
const trusted = new Map([
  ["active", publicKey],
  ["standby", standby.publicKey],
]);
const sha256 = "0123456789abcdef".repeat(4);
const manifest = {
  sha256,
  arch: "x64",
  os: "linux",
  version: "1.2.3",
} as const;
const signature = sign(
  null,
  canonicalRunnerManifest(manifest),
  privateKey
).toString("base64");
const envelope = { manifest, signatures: [{ keyId: "active", signature }] };

describe("runner update signatures", () => {
  it.each(["x64", "arm64"] as const)(
    "pins the canonical bytes for Linux %s",
    (arch) => {
      const bytes = canonicalRunnerManifest({ ...manifest, arch });
      expect(bytes.toString("hex")).toBe(
        "7b2276657273696f6e223a22312e322e33222c226f73223a226c696e7578222c2261726368223a22" +
          (arch === "x64" ? "783634" : "61726d3634") +
          "222c22736861323536223a22" +
          "30313233343536373839616263646566".repeat(4) +
          "227d"
      );
    }
  );

  it("accepts either rotation key and ignores untrusted and invalid signatures", () => {
    expect(verifyRunnerUpdateEnvelope(envelope, trusted)).toEqual(manifest);
    expect(
      verifyRunnerUpdateEnvelope(
        {
          manifest,
          signatures: [
            { keyId: "active", signature: "A".repeat(86) + "==" },
            { keyId: "unknown", signature },
            {
              keyId: "standby",
              signature: sign(
                null,
                canonicalRunnerManifest(manifest),
                standby.privateKey
              ).toString("base64"),
            },
          ],
        },
        trusted
      )
    ).toEqual(manifest);
  });

  it.each([
    [
      "a changed field",
      { ...envelope, manifest: { ...manifest, arch: "arm64" } },
    ],
    ["a missing signature", { manifest, signatures: [] }],
    [
      "an untrusted signing identity",
      { manifest, signatures: [{ keyId: "unknown", signature }] },
    ],
  ])("rejects %s", (_case, candidate) => {
    expect(() => verifyRunnerUpdateEnvelope(candidate, trusted)).toThrow(
      "no valid trusted signature"
    );
  });

  it("keeps the development signing identity out of the production trust set", () => {
    const dev = {
      manifest,
      signatures: [{ keyId: RUNNER_UPDATE_DEV_KEY_ID, signature }],
    };
    expect(
      verifyRunnerUpdateEnvelope(
        dev,
        new Map([[RUNNER_UPDATE_DEV_KEY_ID, publicKey]])
      )
    ).toEqual(manifest);
    expect(() =>
      verifyRunnerUpdateEnvelope(dev, compiledRunnerUpdateKeys())
    ).toThrow("no valid trusted signature");
  });
});

it("starts the release signer using only the workflow's sparse checkout", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const workflow = parse(
    readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8")
  );
  const steps = workflow.jobs["publish-release"].steps as {
    name: string;
    with?: { "sparse-checkout"?: string };
  }[];
  const files = steps.find(
    (step) => step.name === "Check out release signing tools"
  )?.with?.["sparse-checkout"];
  if (!files) throw new Error("Missing signing tools sparse checkout");
  const checkout = mkdtempSync(path.join(tmpdir(), "runner-release-signer-"));
  try {
    for (const entry of files.trim().split("\n")) {
      expect(entry).toMatch(/^\/[\w./-]+$/);
      const destination = path.join(checkout, entry);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(root, entry), destination);
    }
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "scripts/sign-runner-update.mjs",
        "--release",
        "1.2.3",
        "x64",
        "archive.tar.gz",
        "manifest.json",
      ],
      { cwd: checkout, encoding: "utf8", env: {} }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Error: Set RUNNER_UPDATE_SIGNING_KEY and RUNNER_UPDATE_SIGNING_KEY_ID for native releases"
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});
