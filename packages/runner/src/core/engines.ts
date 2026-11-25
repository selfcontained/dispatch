/*
 * Engine inventory and sign-in, served by the core from the platform's
 * engine port, which runs every CLI as the workload account.
 */
import type { CallHandlers } from "../handlers.js";
import type { Platform } from "../platform/types.js";

export function engineHandlers(platform: Platform): CallHandlers {
  const { engines } = platform;
  if (!engines) return {};
  return {
    "engine.models": (request) => engines.models(request),
    "engine.usage": (request) => engines.usage(request),
    "engine.quota.reset": (request) => engines.quotaReset(request),
    "engine.update.inspect": (request) => engines.updateInspect(request),
    "engine.update.spawn": (request) => engines.updateSpawn(request),
    "engine.update.release": (request) => engines.updateRelease(request),
    "engine.update.probe": (request) => engines.updateProbe(request),
    "engine.operation": (request) => engines.operation(request),
    "engine.plugin.status": (request) => engines.pluginStatus(request),
    "engine.plugin.apply": (request) => engines.pluginApply(request),
    "engine.list": (request) => engines.list(request),
    "engine.login.start": (request, context) =>
      engines.loginStart(request, (login) =>
        context.emit({ type: "login_update", login })
      ),
    "engine.login.submit": (request) => engines.loginSubmit(request),
    "engine.login.status": (request) => engines.loginStatus(request),
    "engine.login.cancel": (request) => engines.loginCancel(request),
  };
}
