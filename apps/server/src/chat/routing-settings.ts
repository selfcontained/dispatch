import type { Pool } from "pg";
import {
  routingShadowConfig,
  SHADOW_MODEL,
  type ShadowConfig,
} from "./routing-shadow.js";
export type RoutingMode = "off" | "active";
export class RoutingSettings {
  private cached?: ShadowConfig;
  constructor(
    private readonly pool: Pool,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly transport: typeof fetch = fetch
  ) {}
  private async stored() {
    const read = async () => {
      const rows = await this.pool.query<{ key: string; value: string }>(
        "SELECT key,value FROM settings WHERE key IN ('routing_mode','routing_api_key','steering_mode','merge_risk_mode','dispatch_ai_enabled','dispatch_ai_initialized')"
      );
      return Object.fromEntries(rows.rows.map((r) => [r.key, r.value]));
    };
    const saved = await read();
    // The dev environment is a one-time seed, never a runtime override.
    // An empty stored value records an explicit removal and prevents reseeding.
    if (this.env.DISPATCH_DEV_STACK === "1" && !("routing_api_key" in saved)) {
      const seed = routingShadowConfig(this.env).apiKey;
      if (seed) {
        await this.pool.query(
          "INSERT INTO settings(key,value,updated_at) VALUES('routing_api_key',$1,now()) ON CONFLICT(key) DO NOTHING",
          [seed]
        );
        return read();
      }
    }
    return saved;
  }
  async configuration(): Promise<ShadowConfig> {
    if (this.cached) return this.cached;
    const saved = await this.stored();
    const config = routingShadowConfig(this.env);
    const enabled =
      saved.dispatch_ai_enabled !== "false" && !!saved.routing_api_key;
    const mode = enabled && saved.routing_mode === "active" ? "active" : "off";
    return (this.cached = {
      ...config,
      mode,
      enabled: mode === "active",
      apiKey: saved.routing_api_key || "",
      steeringEnabled: enabled && saved.steering_mode === "active",
      mergeRiskEnabled: enabled && saved.merge_risk_mode === "active",
    });
  }
  isCurrent(config: ShadowConfig) {
    return this.cached === config && !!config.steeringEnabled;
  }
  async status() {
    const saved = await this.stored();
    return {
      routingPreference:
        saved.routing_mode === "active"
          ? ("active" as const)
          : ("off" as const),
      aiEnabled:
        saved.dispatch_ai_enabled === "true" ||
        (saved.dispatch_ai_enabled !== "false" && !!saved.routing_api_key),
      mode:
        saved.dispatch_ai_enabled !== "false" &&
        !!saved.routing_api_key &&
        saved.routing_mode === "active"
          ? ("active" as const)
          : ("off" as const),
      steeringPreference:
        saved.steering_mode === "active"
          ? ("active" as const)
          : ("off" as const),
      mergeRiskPreference:
        saved.merge_risk_mode === "active"
          ? ("active" as const)
          : ("off" as const),
      steeringMode:
        saved.dispatch_ai_enabled !== "false" &&
        !!saved.routing_api_key &&
        saved.steering_mode === "active"
          ? ("active" as const)
          : ("off" as const),
      mergeRiskMode:
        saved.dispatch_ai_enabled !== "false" &&
        !!saved.routing_api_key &&
        saved.merge_risk_mode === "active"
          ? ("active" as const)
          : ("off" as const),
      modeSource: "settings",
      configured: !!saved.routing_api_key,
      keySource: saved.routing_api_key ? "settings" : "none",
      storedKey: !!saved.routing_api_key,
      dailyCap: routingShadowConfig(this.env).dailyCap,
    };
  }
  /** Non-generating check. Never return arbitrary provider text (it may echo secrets). */
  async check(apiKey?: string) {
    const candidate = apiKey ?? (await this.configuration()).apiKey;
    if (!candidate)
      return {
        status: "unconfigured",
        message: "No saved API key. Enter an OpenAI API key.",
      };
    try {
      const response = await this.transport(
        `https://api.openai.com/v1/models/${SHADOW_MODEL}`,
        {
          headers: { Authorization: `Bearer ${candidate}` },
          signal: AbortSignal.timeout(10000),
        }
      );
      if (response.ok)
        return {
          status: "ok",
          message:
            "API key and model-read access verified. Inference permissions and quota are not tested.",
        };
      const status = response.status;
      const detail =
        status === 401
          ? "Invalid or expired API key. Replace the API key."
          : status === 403
            ? "Permission denied. Grant model-read permission in the OpenAI project."
            : status === 404
              ? "Routing model unavailable for this project. Check model access."
              : status === 429
                ? "Rate or quota limit reached. Check OpenAI billing and retry later."
                : status >= 500
                  ? "OpenAI service unavailable. Retry later."
                  : "OpenAI rejected the check. Check project configuration and retry.";
      return {
        status: "provider_error",
        message: `OpenAI HTTP ${status}: ${detail}`,
      };
    } catch (error) {
      const timeout =
        error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name);
      return {
        status: "error",
        message: timeout
          ? "OpenAI check timed out. Retry."
          : "Could not reach OpenAI. Check the server network and retry.",
      };
    }
  }
  async save(input: {
    aiEnabled?: boolean;
    mode?: RoutingMode;
    steeringMode?: RoutingMode;
    mergeRiskMode?: RoutingMode;
    apiKey?: string;
    removeKey?: boolean;
  }) {
    if (input.apiKey !== undefined && !input.removeKey) {
      const result = await this.check(input.apiKey);
      if (result.status !== "ok")
        throw new TokenValidationError(result.message);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize preference transitions, including concurrent first-key saves.
      await client.query("SELECT pg_advisory_xact_lock(87412031)");
      const rows = await client.query<{ key: string; value: string }>(
        "SELECT key,value FROM settings WHERE key IN ('routing_api_key','dispatch_ai_initialized')"
      );
      const previous = Object.fromEntries(
        rows.rows.map((r) => [r.key, r.value])
      );
      // Existing keys are migrated without changing deliberate feature choices.
      // Removal never resets initialization; replacement and re-enable preserve choices.
      const firstSetup =
        !!input.apiKey &&
        !previous.routing_api_key &&
        previous.dispatch_ai_initialized !== "true";
      const initialized =
        firstSetup ||
        !!previous.routing_api_key ||
        previous.dispatch_ai_initialized === "true";
      for (const [key, value] of [
        [
          "dispatch_ai_enabled",
          input.removeKey
            ? "false"
            : input.aiEnabled === undefined
              ? undefined
              : String(input.aiEnabled),
        ],
        ["dispatch_ai_initialized", initialized ? "true" : undefined],
        ["routing_mode", input.mode ?? (firstSetup ? "active" : undefined)],
        ["routing_api_key", input.apiKey],
        [
          "steering_mode",
          input.steeringMode ?? (firstSetup ? "active" : undefined),
        ],
        [
          "merge_risk_mode",
          input.mergeRiskMode ?? (firstSetup ? "active" : undefined),
        ],
      ] as const) {
        if (value !== undefined)
          await client.query(
            "INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=now()",
            [key, value]
          );
      }
      if (input.removeKey)
        await client.query(
          "INSERT INTO settings(key,value,updated_at) VALUES('routing_api_key','',now()) ON CONFLICT(key) DO UPDATE SET value='',updated_at=now()"
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    this.cached = undefined;
    await this.configuration();
    return this.status();
  }
}

export class TokenValidationError extends Error {}
