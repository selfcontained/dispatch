import { inspectCheckout as inspect } from "../../src/agents/checkout-inspection.js";
import { toPersonaDefinition } from "../../src/personas/loader.js";
export * from "../../src/agents/checkout-inspection.js";
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
