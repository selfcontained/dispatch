import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { verifySignedManifest } from "@dispatch/runner-protocol/update-format";

export type RunnerUpdateKeys = ReadonlyMap<string, string | KeyObject>;

export function verifyRunnerUpdateEnvelope(
  envelope: unknown,
  keys: RunnerUpdateKeys
) {
  return verifySignedManifest(
    envelope,
    keys,
    (configured, bytes, signature) => {
      const key =
        typeof configured === "string"
          ? createPublicKey(configured)
          : configured;
      return (
        key.type === "public" &&
        key.asymmetricKeyType === "ed25519" &&
        verify(null, bytes, key, signature)
      );
    }
  );
}

import {
  canonicalManifestBytes,
  type RunnerUpdateManifest,
} from "@dispatch/runner-protocol/update-format";
export {
  RUNNER_ARCHES,
  RUNNER_UPDATE_VERSION,
  RUNNER_UPDATE_DIGEST,
  RUNNER_UPDATE_KEY_ID,
  RUNNER_UPDATE_MANIFEST_LIMIT,
  runnerManifestName,
  runnerExecutableMember,
  type RunnerUpdateManifest,
  type RunnerArch,
} from "@dispatch/runner-protocol/update-format";

export function canonicalRunnerManifest(manifest: RunnerUpdateManifest) {
  return Buffer.from(canonicalManifestBytes(manifest));
}
