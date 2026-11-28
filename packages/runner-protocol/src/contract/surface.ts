import { runnerDescription } from "./description.js";
import { COMMON_ERRORS, ERROR_CODES } from "./errors.js";
import type { OperationSpec } from "./operation.js";
import { operations } from "./operations.js";

/** Protocol version of this contract. Wire v1 is carried by the codec. */
export const CONTRACT_VERSION = 2;

function describeOperation(spec: OperationSpec) {
  const channel = spec.channel && {
    toRunner:
      spec.channel.toRunner === "bytes" ? "bytes" : spec.channel.toRunner.shape,
    fromRunner:
      spec.channel.fromRunner === "bytes"
        ? "bytes"
        : spec.channel.fromRunner.shape,
  };
  return {
    scope: spec.scope,
    kind: spec.kind,
    request: spec.request.shape,
    response: spec.response.shape,
    errors: [...spec.errors],
    retry: spec.retry,
    timeout: spec.timeout,
    capability: spec.capability,
    ...(spec.events && { events: spec.events.shape }),
    ...(channel && { channel }),
    ...(spec.cancellable && { cancellable: true }),
  };
}

/**
 * The whole public surface as data. `surface.json` is this value, committed;
 * any change to an operation, field, error or capability changes it.
 */
export function surface() {
  return {
    version: CONTRACT_VERSION,
    errors: [...ERROR_CODES],
    commonErrors: [...COMMON_ERRORS],
    description: runnerDescription.shape,
    operations: Object.fromEntries(
      Object.entries(operations as Record<string, OperationSpec>).map(
        ([name, spec]) => [name, describeOperation(spec)]
      )
    ),
  };
}
