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
// The Bun build script substitutes a literal public key. Runtime environment
// variables cannot give a compiled production binary a development trust root.
declare const DISPATCH_COMPILED_RUNNER_DEV_KEY: string | undefined;

export function compiledRunnerDevKey(): string | undefined {
  return typeof DISPATCH_COMPILED_RUNNER_DEV_KEY === "string"
    ? DISPATCH_COMPILED_RUNNER_DEV_KEY
    : undefined;
}
