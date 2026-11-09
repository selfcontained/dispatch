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
        "SELECT key,value FROM settings WHERE key IN ('routing_mode','routing_api_key','steering_mode')"
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
    const mode = saved.routing_mode === "active" ? "active" : "off";
    return (this.cached = {
      ...config,
      mode,
      enabled: mode === "active",
      apiKey: saved.routing_api_key || "",
      steeringEnabled: saved.steering_mode === "active",
    });
  }
  isCurrent(config: ShadowConfig) {
    return this.cached === config && !!config.steeringEnabled;
  }
  async status() {
    const saved = await this.stored();
    return {
      mode:
        saved.routing_mode === "active"
          ? ("active" as const)
          : ("off" as const),
      steeringMode:
        saved.steering_mode === "active"
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
        message: "No saved token. Enter an OpenAI API token.",
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
            "Token and model-read access verified. Inference permissions and quota are not tested.",
        };
      const status = response.status;
      const detail =
        status === 401
          ? "Invalid or expired API token. Replace the token."
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
    mode?: RoutingMode;
    steeringMode?: RoutingMode;
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
      for (const [key, value] of [
        ["routing_mode", input.removeKey ? "off" : input.mode],
        ["routing_api_key", input.apiKey],
        ["steering_mode", input.removeKey ? "off" : input.steeringMode],
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
