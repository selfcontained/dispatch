import type { Pool } from "pg";
import { routingShadowConfig, type ShadowConfig } from "./routing-shadow.js";
export type RoutingMode = "off" | "shadow" | "active";
export class RoutingSettings {
  private cached?: ShadowConfig;
  constructor(
    private readonly pool: Pool,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}
  private async stored() {
    const rows = await this.pool.query<{ key: string; value: string }>(
      "SELECT key,value FROM settings WHERE key IN ('routing_mode','routing_api_key')"
    );
    return Object.fromEntries(rows.rows.map((r) => [r.key, r.value]));
  }
  async configuration(): Promise<ShadowConfig> {
    if (this.cached) return this.cached;
    const saved = await this.stored();
    const config = routingShadowConfig(this.env);
    const mode =
      this.env.DISPATCH_ROUTING_MODE !== undefined ||
      this.env.DISPATCH_ROUTING_SHADOW_ENABLED !== undefined
        ? config.mode!
        : ((saved.routing_mode ?? "off") as RoutingMode);
    return (this.cached = {
      ...config,
      mode,
      enabled: mode !== "off",
      apiKey: config.apiKey || saved.routing_api_key || "",
    });
  }
  async status() {
    const saved = await this.stored();
    const config = routingShadowConfig(this.env);
    const modeOverride =
      this.env.DISPATCH_ROUTING_MODE !== undefined ||
      this.env.DISPATCH_ROUTING_SHADOW_ENABLED !== undefined;
    return {
      mode: modeOverride
        ? config.mode!
        : ((saved.routing_mode ?? "off") as RoutingMode),
      modeSource: modeOverride ? "environment" : "settings",
      configured: !!(config.apiKey || saved.routing_api_key),
      keySource: config.apiKey
        ? "environment"
        : saved.routing_api_key
          ? "settings"
          : "none",
      storedKey: !!saved.routing_api_key,
      dailyCap: config.dailyCap,
    };
  }
  async save(input: {
    mode?: RoutingMode;
    apiKey?: string;
    removeKey?: boolean;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [key, value] of [
        ["routing_mode", input.mode],
        ["routing_api_key", input.apiKey],
      ] as const) {
        if (value !== undefined)
          await client.query(
            "INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=now()",
            [key, value]
          );
      }
      if (input.removeKey)
        await client.query(
          "DELETE FROM settings WHERE key = 'routing_api_key'"
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
