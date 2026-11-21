// Provision the active and standby public keys here as [key ID, SPKI PEM] pairs.
// See docs/runner-update-signing.md.
export const productionRunnerUpdateKeys: ReadonlyMap<string, string> = new Map([
  // Active key slot.
  // Standby rotation key slot.
]);

export const RUNNER_UPDATE_DEV_KEY_ID = "dispatch-local-dev";

// The Bun build script substitutes a literal public key. Runtime environment
// variables cannot give a compiled production binary a development trust root.
declare const DISPATCH_COMPILED_RUNNER_DEV_KEY: string | undefined;

export function compiledRunnerDevKey(): string | undefined {
  return typeof DISPATCH_COMPILED_RUNNER_DEV_KEY === "string"
    ? DISPATCH_COMPILED_RUNNER_DEV_KEY
    : undefined;
}

export function compiledRunnerUpdateKeys(): ReadonlyMap<string, string> {
  const devKey = compiledRunnerDevKey();
  return devKey
    ? new Map([[RUNNER_UPDATE_DEV_KEY_ID, devKey]])
    : productionRunnerUpdateKeys;
}
