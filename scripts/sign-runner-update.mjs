#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalManifestBytes,
  runnerExecutableMember,
  RUNNER_ARCHES,
  RUNNER_UPDATE_KEY_ID,
  RUNNER_UPDATE_VERSION,
  verifySignedManifest,
  productionRunnerUpdateKeys,
  RUNNER_UPDATE_DEV_KEY_ID,
} from "../packages/runner-protocol/src/update-format.ts";
import { loadRunnerDevKey } from "./runner-dev-key.mjs";

const [mode, version, arch, archive, output, ...extra] = process.argv.slice(2);
if (
  (mode !== "--release" && mode !== "--dev") ||
  !version ||
  !RUNNER_UPDATE_VERSION.test(version) ||
  !RUNNER_ARCHES.includes(arch) ||
  !archive ||
  !output ||
  extra.length
) {
  throw new Error(
    "Usage: sign-runner-update.mjs --release|--dev VERSION ARCH ARCHIVE OUTPUT"
  );
}

const dev = mode === "--dev" ? loadRunnerDevKey() : undefined;
const keyId = dev
  ? RUNNER_UPDATE_DEV_KEY_ID
  : process.env.RUNNER_UPDATE_SIGNING_KEY_ID;
const pem = process.env.RUNNER_UPDATE_SIGNING_KEY;
if (!keyId || !RUNNER_UPDATE_KEY_ID.test(keyId) || (!dev && !pem))
  throw new Error(
    "Set RUNNER_UPDATE_SIGNING_KEY and RUNNER_UPDATE_SIGNING_KEY_ID for native releases"
  );
const privateKey = dev?.privateKey ?? createPrivateKey(pem);
if (privateKey.asymmetricKeyType !== "ed25519")
  throw new Error("The runner update signing key must be Ed25519");

const tar = spawn(
  "tar",
  ["xOf", path.resolve(archive), runnerExecutableMember(version, arch)],
  {
    stdio: ["ignore", "pipe", "inherit"],
  }
);
const exited = new Promise((resolve) => {
  tar.once("error", () => resolve(null));
  tar.once("close", resolve);
});
let size = 0;
const hash = createHash("sha256");
for await (const chunk of tar.stdout) {
  size += chunk.length;
  hash.update(chunk);
}
if ((await exited) !== 0 || size === 0)
  throw new Error("Could not read the runner executable from the archive");
const manifest = { version, os: "linux", arch, sha256: hash.digest("hex") };
const signature = sign(
  null,
  canonicalManifestBytes(manifest),
  privateKey
).toString("base64");
const envelope = { manifest, signatures: [{ keyId, signature }] };
verifySignedManifest(
  envelope,
  dev ? new Map([[keyId, dev.publicKey]]) : productionRunnerUpdateKeys,
  (pem, bytes, signature) => {
    const key = createPublicKey(pem);
    return (
      key.asymmetricKeyType === "ed25519" && verify(null, bytes, key, signature)
    );
  }
);
await writeFile(output, JSON.stringify(envelope) + "\n");
