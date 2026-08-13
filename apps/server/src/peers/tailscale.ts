import { runCommand } from "../shared/lib/run-command.js";

/**
 * Thin wrapper around the tailscale CLI. We shell out instead of talking to
 * the LocalAPI socket because the socket transport differs per platform
 * (root-owned unix socket on Linux, authed localhost TCP on macOS) and the
 * CLI already abstracts both.
 */

export type TailscaleSelf = {
  /** Durable node identifier — the only field safe to authorize on. */
  stableId: string;
  /** MagicDNS name without the trailing dot, e.g. host.tailnet.ts.net */
  dnsName: string;
  /** Tailnet IPs (IPv4 100.x and IPv6). */
  ips: string[];
  online: boolean;
};

export type TailscaleWhois = {
  stableId: string;
  nodeName: string;
  tags: string[];
  /** Set when the node is shared in from another tailnet — its user is not ours. */
  sharer: string | null;
  loginName: string | null;
};

const BIN_CANDIDATES = [
  process.env.DISPATCH_TAILSCALE_BIN,
  "tailscale",
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
].filter((c): c is string => Boolean(c));

let cachedBin: string | null | undefined;

export async function findTailscaleBin(): Promise<string | null> {
  if (cachedBin !== undefined) return cachedBin;
  for (const candidate of BIN_CANDIDATES) {
    try {
      await runCommand(candidate, ["version"], { timeoutMs: 5_000 });
      cachedBin = candidate;
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  cachedBin = null;
  return null;
}

/** Test-only: forget the memoized binary lookup. */
export function resetTailscaleBinCache(): void {
  cachedBin = undefined;
}

function stripTrailingDot(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/**
 * Returns this node's tailnet identity, or null when tailscale is absent,
 * logged out, or its output cannot be understood. The LocalAPI is semi-stable
 * with no published schema, so every field read is defensive.
 */
export async function getTailscaleSelf(): Promise<TailscaleSelf | null> {
  const bin = await findTailscaleBin();
  if (!bin) return null;
  try {
    const result = await runCommand(bin, ["status", "--json"], {
      timeoutMs: 10_000,
    });
    return parseTailscaleStatus(result.stdout);
  } catch {
    return null;
  }
}

export function parseTailscaleStatus(stdout: string): TailscaleSelf | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const status = parsed as Record<string, unknown>;
  if (status.BackendState !== "Running") return null;
  const self = status.Self as Record<string, unknown> | undefined;
  if (!self || typeof self.ID !== "string" || self.ID.length === 0) return null;
  const dnsName = typeof self.DNSName === "string" ? self.DNSName : "";
  return {
    stableId: self.ID,
    dnsName: stripTrailingDot(dnsName),
    ips: asStringArray(self.TailscaleIPs),
    online: self.Online === true,
  };
}

/**
 * Identifies the tailnet node behind a connection. `addr` should include the
 * source port (matters in userspace mode). Returns null when the address is
 * not a tailnet peer — callers must treat that as a hard deny, never a
 * fallback to weaker identification.
 */
export async function tailscaleWhois(
  addr: string
): Promise<TailscaleWhois | null> {
  const bin = await findTailscaleBin();
  if (!bin) return null;
  try {
    const result = await runCommand(bin, ["whois", "--json", addr], {
      timeoutMs: 10_000,
    });
    return parseTailscaleWhois(result.stdout);
  } catch {
    return null;
  }
}

export function parseTailscaleWhois(stdout: string): TailscaleWhois | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const whois = parsed as Record<string, unknown>;
  const node = whois.Node as Record<string, unknown> | undefined;
  if (!node || typeof node.StableID !== "string" || node.StableID.length === 0)
    return null;
  const profile = whois.UserProfile as Record<string, unknown> | undefined;
  return {
    stableId: node.StableID,
    nodeName: stripTrailingDot(typeof node.Name === "string" ? node.Name : ""),
    tags: asStringArray(node.Tags),
    sharer:
      typeof node.Sharer === "string" && node.Sharer.length > 0
        ? node.Sharer
        : null,
    loginName:
      typeof profile?.LoginName === "string" ? profile.LoginName : null,
  };
}

/** Picks the IPv4 tailnet address to bind the peer listener on. */
export function pickTailnetIPv4(ips: string[]): string | null {
  return ips.find((ip) => ip.startsWith("100.") && !ip.includes(":")) ?? null;
}
