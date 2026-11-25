import { createCheckoutWorkload } from "../../src/agents/checkout-worker.js";
import { toPersonaDefinition } from "../../src/personas/loader.js";
export * from "../../src/agents/checkout-worker.js";
export const checkoutWorkload = createCheckoutWorkload({
  parseDefinition: toPersonaDefinition,
});
