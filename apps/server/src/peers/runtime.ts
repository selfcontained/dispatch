import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

import { getOrCreateInstanceId } from "./identity.js";
import { isTailnetBindEnabled } from "./peer-settings.js";
import {
  getTailscaleSelf,
  pickTailnetIPv4,
  type TailscaleSelf,
} from "./tailscale.js";
import type { TailnetListener } from "./tailnet-listener.js";

export type TailnetBindStatus = {
  enabled: boolean;
  /** Actually listening right now (enabled + password + tailscale all held). */
  active: boolean;
  address: string | null;
  /** Why the listener is not active despite being enabled, for the UI. */
  blockedReason: "no-password" | "no-tailscale" | null;
};

export type PeerSelfStatus = {
  instanceId: string;
  passwordSet: boolean;
  tailscale: TailscaleSelf | null;
  bind: TailnetBindStatus;
};

type PeerRuntimeDeps = {
  pool: Pool;
  listener: TailnetListener;
  isPasswordSet: () => Promise<boolean>;
  log: FastifyBaseLogger;
};

/**
 * Owns the tailnet exposure lifecycle: reads the bind setting and starts or
 * stops the tailnet listener to match. A missing password is a hard stop —
 * first-run mode leaves every route open, and the tailnet is not a perimeter.
 */
export class PeerRuntime {
  constructor(private readonly deps: PeerRuntimeDeps) {}

  async applyTailnetBind(): Promise<TailnetBindStatus> {
    const enabled = await isTailnetBindEnabled(this.deps.pool);
    if (!enabled) {
      await this.deps.listener.stop();
      return { enabled, active: false, address: null, blockedReason: null };
    }
    if (!(await this.deps.isPasswordSet())) {
      await this.deps.listener.stop();
      this.deps.log.warn(
        "Tailnet bind is enabled but no password is set — refusing to expose the API"
      );
      return {
        enabled,
        active: false,
        address: null,
        blockedReason: "no-password",
      };
    }
    const self = await getTailscaleSelf();
    const address = self ? pickTailnetIPv4(self.ips) : null;
    if (!address) {
      await this.deps.listener.stop();
      this.deps.log.warn(
        "Tailnet bind is enabled but tailscale is not running or has no IPv4 address"
      );
      return {
        enabled,
        active: false,
        address: null,
        blockedReason: "no-tailscale",
      };
    }
    await this.deps.listener.start(address);
    return { enabled, active: true, address, blockedReason: null };
  }

  async selfStatus(): Promise<PeerSelfStatus> {
    const [instanceId, passwordSet, tailscale, enabled] = await Promise.all([
      getOrCreateInstanceId(this.deps.pool),
      this.deps.isPasswordSet(),
      getTailscaleSelf(),
      isTailnetBindEnabled(this.deps.pool),
    ]);
    const active = this.deps.listener.address !== null;
    return {
      instanceId,
      passwordSet,
      tailscale,
      bind: {
        enabled,
        active,
        address: this.deps.listener.address,
        blockedReason: !enabled
          ? null
          : !passwordSet
            ? "no-password"
            : !tailscale
              ? "no-tailscale"
              : null,
      },
    };
  }

  async shutdown(): Promise<void> {
    await this.deps.listener.stop();
  }
}
