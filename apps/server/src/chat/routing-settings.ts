import type { Pool } from "pg";
import { routingShadowConfig, type ShadowConfig } from "./routing-shadow.js";
export type RoutingMode = "off" | "active";
export class RoutingSettings {
  private cached?: ShadowConfig;
  constructor(
    private readonly pool: Pool,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}
  private async stored() {
    const read = async () => {
      const rows = await this.pool.query<{ key: string; value: string }>(
        "SELECT key,value FROM settings WHERE key IN ('routing_mode','routing_api_key')"
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
    });
  }
  async status() {
    const saved = await this.stored();
    return {
      mode:
        saved.routing_mode === "active"
          ? ("active" as const)
          : ("off" as const),
      modeSource: "settings",
      configured: !!saved.routing_api_key,
      keySource: saved.routing_api_key ? "settings" : "none",
      storedKey: !!saved.routing_api_key,
      dailyCap: routingShadowConfig(this.env).dailyCap,
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
        ["routing_mode", input.removeKey ? "off" : input.mode],
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
