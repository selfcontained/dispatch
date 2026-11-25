import { createProviderPlansReporter as createReporter } from "../../src/agents/provider-plans-reporter.js";
import {
  loadProviderPlans,
  type ProviderPlanOptions,
} from "../../src/agents/provider-plans.js";

export function createProviderPlansReporter(
  options: Omit<ProviderPlanOptions, "now"> & {
    load?: () => ReturnType<typeof loadProviderPlans>;
  },
  cacheMs?: number
) {
  return createReporter(
    {
      load: options.load ?? (() => loadProviderPlans(options)),
      log: options.log,
    },
    cacheMs
  );
}
