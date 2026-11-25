import { randomBytes } from "node:crypto";

import type {
  EngineCapabilityOperation,
  EngineCapabilityResult,
  EngineOperationAck,
} from "@dispatch/runner-protocol/engine-management";

import {
  agentModelCatalog,
  agentModelDefaults,
  getAgentModelOptions,
} from "../shared/agent-models.js";
import {
  createPluginStatusChecker,
  type PluginStatusLogger,
} from "../shared/plugin-status.js";
import { findEngineBin } from "./engine-availability.js";
import {
  CodexResetError,
  consumeCodexLimitReset,
  loadWorkloadProviderPlans,
  type ProviderPlanOptions,
} from "./provider-plans.js";
import { parseEngineCapabilityResult } from "./remote/engine-capability-result.js";

/**
 * Native runner-wide operations. Like native checkout operations, this
 * runner shares the service's OS identity. The CLI, credential and catalog
 * reads belong here so host presentation and policy have one owner boundary.
 */
export function createLocalEngineRunner(
  options: {
    bins?: { claude: string; codex: string };
    logger?: PluginStatusLogger;
    providerOptions?: ProviderPlanOptions;
  } = {}
) {
  const { bins = { claude: "claude", codex: "codex" }, logger } = options;
  const providerOptions = { log: logger, ...options.providerOptions };
  const secret = randomBytes(32).toString("base64url");
  const plugins = createPluginStatusChecker({
    binFor: async (engine) =>
      (await findEngineBin(bins[engine])) ?? bins[engine],
    logger,
  });

  async function handle(
    operation: EngineCapabilityOperation
  ): Promise<EngineOperationAck> {
    let result: EngineCapabilityResult;
    try {
      switch (operation.type) {
        case "model_catalog":
          // Native ACP hosts already publish their model and effort choices
          // during launch. Serve that observation without starting a session
          // merely to open the picker. The existing shipped catalog is the fallback.
          result = {
            type: operation.type,
            catalog: {
              defaultModel: agentModelDefaults()[operation.engine] ?? null,
              models: [...getAgentModelOptions(operation.engine)],
            },
          };
          break;
        case "provider_usage":
          result = {
            type: operation.type,
            usage: await loadWorkloadProviderPlans(secret, providerOptions),
          };
          break;
        case "codex_reset": {
          const { code, windowsReset } = await consumeCodexLimitReset({
            ...providerOptions,
            requestId: operation.requestId,
            account: { secret, handle: operation.account },
          });
          result = {
            type: operation.type,
            code: ["ok", "no_credit", "nothing_to_reset"].includes(code)
              ? code
              : "unknown",
            windowsReset,
          };
          break;
        }
        case "plugin_status":
        case "plugin_install":
        case "plugin_update": {
          if (operation.plugin !== "dispatch@dispatch") {
            return {
              ok: false,
              unsupported: true,
              error: "This plugin is unavailable on the native runner.",
            };
          }
          const change =
            operation.type === "plugin_install"
              ? await plugins.install(operation.engine)
              : operation.type === "plugin_update"
                ? await plugins.update(operation.engine)
                : null;
          if (change?.error) return { ok: false, error: change.error };
          const status =
            change?.status ?? (await plugins.getStatus(operation.engine));
          if (status.detectionError)
            return { ok: false, error: status.detectionError };
          result = {
            type: "plugin_status",
            status: {
              ...status,
              actions: status.installed ? ["update"] : ["install"],
            },
          };
          break;
        }
      }
      const capability = parseEngineCapabilityResult(operation, result);
      if (capability) return { ok: true, capability };
    } catch (error) {
      if (error instanceof CodexResetError) {
        return {
          ok: false,
          ...(error.reason === "account_changed" && {
            reason: "account_changed" as const,
          }),
          error: error.message,
        };
      }
    }
    return {
      ok: false,
      error: "Engine capability is unavailable on the native runner.",
    };
  }

  return {
    handle,
    readModelCatalog: () => ({
      models: agentModelCatalog(),
      defaults: agentModelDefaults(),
    }),
    readModelOptions: async (
      engine: Parameters<typeof getAgentModelOptions>[0]
    ) => getAgentModelOptions(engine),
  };
}

export type LocalEngineRunner = ReturnType<typeof createLocalEngineRunner>;
