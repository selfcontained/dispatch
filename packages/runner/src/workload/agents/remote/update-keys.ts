import {
  productionRunnerUpdateKeys,
  RUNNER_UPDATE_DEV_KEY_ID,
} from "@dispatch/runner-protocol/update-format";
export {
  productionRunnerUpdateKeys,
  RUNNER_UPDATE_DEV_KEY_ID,
} from "@dispatch/runner-protocol/update-format";
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
