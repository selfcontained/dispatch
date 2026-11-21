import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compiledRunnerUpdateKeys,
  RUNNER_UPDATE_DEV_KEY_ID,
} from "../src/agents/remote/update-keys.js";
import {
  canonicalRunnerManifest,
  verifyRunnerUpdateEnvelope,
} from "../src/agents/remote/update-manifest.js";

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
