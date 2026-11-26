import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyRunnerUpdateEnvelope as runner } from "../../../packages/runner/src/workload/agents/remote/update-manifest.js";

import { verifyRunnerUpdateEnvelope as controller } from "../src/server/update-trust.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const manifest = {
  version: "1.2.3",
  os: "linux",
  arch: "x64",
  sha256: "0".repeat(64),
};
const bytes = sign(null, Buffer.from(JSON.stringify(manifest)), privateKey);
const signature = bytes.toString("base64");
const changed = Buffer.from(bytes);
changed[0] = changed[0]! ^ 1;
const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const alteredPadding =
  signature.slice(0, -3) +
  alphabet[alphabet.indexOf(signature.at(-3)!) + 1] +
  "==";
const entry = { keyId: "active", signature };
const keys = new Map([["active", publicKey]]);
const signatures = [entry];
const envelope = { manifest, signatures };

for (const [name, verify] of Object.entries({ runner, controller })) {
  describe(name, () => {
    it.each([
      ["canonical", envelope],
      [
        "noncanonical pad bits",
        { manifest, signatures: [{ ...entry, signature: alteredPadding }] },
      ],
      [
        "reordered fields",
        {
          manifest: {
            sha256: manifest.sha256,
            arch: manifest.arch,
            os: manifest.os,
            version: manifest.version,
          },
          signatures,
        },
      ],
      ["duplicate signer", { manifest, signatures: [entry, entry] }],
      [
        "unknown then trusted signer",
        { manifest, signatures: [{ ...entry, keyId: "other" }, entry] },
      ],
    ] as const)("accepts %s", (_case, candidate) => {
      expect(verify(candidate, keys)).toEqual(manifest);
    });
    it.each([
      [
        "wrong key",
        envelope,
        new Map([["active", generateKeyPairSync("ed25519").publicKey]]),
      ],
      [
        "wrong algorithm",
        envelope,
        new Map([
          [
            "active",
            generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey,
          ],
        ]),
      ],
      [
        "changed message",
        { manifest: { ...manifest, version: "1.2.2" }, signatures },
        keys,
      ],
      [
        "changed signature",
        {
          manifest,
          signatures: [{ ...entry, signature: changed.toString("base64") }],
        },
        keys,
      ],
      [
        "truncated signature",
        {
          manifest,
          signatures: [{ ...entry, signature: signature.slice(0, -4) }],
        },
        keys,
      ],
      [
        "empty signature",
        { manifest, signatures: [{ ...entry, signature: "" }] },
        keys,
      ],
      [
        "unknown signer",
        { manifest, signatures: [{ ...entry, keyId: "other" }] },
        keys,
      ],
      [
        "extra field",
        { manifest: { ...manifest, extra: true }, signatures },
        keys,
      ],
    ] as const)("rejects %s", (_case, candidate, trust) => {
      expect(() => verify(candidate, trust)).toThrow();
    });
  });
}
