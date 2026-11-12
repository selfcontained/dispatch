import os from "node:os";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type BoundAddress = { address: string; port: number };
export type SlackLinkOrigins = {
  options: { url: string; loopback: boolean }[];
  defaultUrl: string | null;
};
const loopback = (host: string) =>
  /^127\./.test(host) || host === "::1" || /^::ffff:127\./i.test(host);
const concreteIp = (host: string) =>
  !!isIP(host) &&
  !host.includes("%") &&
  !["0.0.0.0", "::"].includes(host) &&
  !/^fe[89ab]/i.test(host) &&
  !/^ff/i.test(host);

/** Active listeners only. Neither request Host/forwarded headers nor DNS aliases
 * from the browser are inputs. Interface enumeration is not a reachability test. */
export async function discoverSlackLinkOrigins(
  input: { addresses: BoundAddress[]; tls: boolean; configuredHost?: string },
  deps: {
    interfaces?: () => ReturnType<typeof os.networkInterfaces>;
    resolve?: (hostname: string) => Promise<string[]>;
  } = {}
): Promise<SlackLinkOrigins> {
  const candidates = new Map<
    string,
    { url: string; loopback: boolean; virtual: boolean }
  >();
  const interfaces = deps.interfaces ?? os.networkInterfaces;
  const add = (host: string, port: number, local: boolean, virtual = false) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const authority = isIP(host) === 6 ? `[${host}]` : host;
    const url = new URL(
      `${input.tls ? "https" : "http"}://${authority}:${port}`
    ).origin;
    const previous = candidates.get(url);
    if (!previous || Number(virtual) < Number(previous.virtual))
      candidates.set(url, { url, loopback: local, virtual });
  };
  for (const bound of input.addresses) {
    if (bound.address === "0.0.0.0" || bound.address === "::") {
      // Conservatively advertise only the wildcard's family, regardless of
      // platform-dependent IPv6 dual-stack behavior.
      const family = bound.address === "::" ? 6 : 4;
      for (const [name, entries] of Object.entries(interfaces()))
        for (const entry of entries ?? []) {
          if (concreteIp(entry.address) && isIP(entry.address) === family)
            add(
              entry.address,
              bound.port,
              loopback(entry.address),
              /^(docker|br-|veth|bridge|utun|vmnet)/i.test(name)
            );
        }
      add(family === 4 ? "127.0.0.1" : "::1", bound.port, true);
    } else if (concreteIp(bound.address))
      add(bound.address, bound.port, loopback(bound.address));
  }
  const hostname = input.configuredHost;
  if (
    input.addresses.length &&
    hostname &&
    !isIP(hostname) &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(hostname)
  ) {
    const resolve =
      deps.resolve ??
      (async (host) =>
        (await lookup(host, { all: true })).map((x) => x.address));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const addresses: string[] = await Promise.race([
      resolve(hostname).catch(() => []),
      new Promise<string[]>((r) => {
        timer = setTimeout(() => r([]), 1000);
      }),
    ]).finally(() => clearTimeout(timer));
    for (const bound of input.addresses)
      if (addresses.includes(bound.address))
        add(hostname, bound.port, loopback(bound.address));
  }
  // Preference only: interface names do not prove remote reachability.
  const options = [...candidates.values()]
    .sort(
      (a, b) =>
        Number(a.loopback) - Number(b.loopback) ||
        Number(a.virtual) - Number(b.virtual)
    )
    .map(({ url, loopback }) => ({ url, loopback }));
  return { options, defaultUrl: options[0]?.url ?? null };
}

export function isAllowedSlackLinkOrigin(
  value: string,
  origins: SlackLinkOrigins
): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      origins.options.some((option) => option.url === url.origin)
    );
  } catch {
    return false;
  }
}
