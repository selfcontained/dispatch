import { createCheckoutWorkload } from "../../../../packages/runner/src/workload/agents/checkout-worker.js";
import { toPersonaDefinition } from "../../src/personas/loader.js";
export * from "../../../../packages/runner/src/workload/agents/checkout-worker.js";
export const checkoutWorkload = createCheckoutWorkload({
  parseDefinition: toPersonaDefinition,
});
