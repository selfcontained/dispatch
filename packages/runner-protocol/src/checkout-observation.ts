import type { CheckoutObservation, CheckoutState } from "./checkout.js";

export function observeBoundCheckout(
  agentId: string,
  owner: string,
  borrowers: string[],
  checkout: CheckoutState | null
): CheckoutObservation {
  return {
    ownership: owner === agentId ? "owned" : "borrowed",
    owner,
    borrowers,
    checkout,
  };
}
