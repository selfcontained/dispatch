import { inspectCheckout as inspect } from "../../../../packages/runner/src/workload/agents/checkout-inspection.js";
import { toPersonaDefinition } from "../../src/personas/loader.js";
export * from "../../../../packages/runner/src/workload/agents/checkout-inspection.js";
export function inspectCheckout(
  cwd: string,
  query: Parameters<typeof inspect>[1],
  options:
    | Parameters<typeof inspect>[2]
    | Omit<Parameters<typeof inspect>[2], "parseDefinition"> = {}
) {
  return inspect(cwd, query, {
    parseDefinition: toPersonaDefinition,
    ...options,
  });
}
