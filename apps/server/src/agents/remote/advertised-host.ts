import os from "node:os";

function isLoopbackHost(host: string) {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    bare === "::1" ||
    bare === "0.0.0.0" ||
    bare === "::" ||
    /^127\./.test(bare) ||
    /^::ffff:127\./.test(bare)
  );
}

/**
 * The host written into pairing commands. A browser on the Dispatch machine
 * itself reaches it via loopback, which a remote runner cannot use, so fall
 * back to this machine's LAN address (private IPv4 first), then its hostname.
 */
export function advertisedHost(
  hint: string | undefined,
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
  hostname = os.hostname()
) {
  if (hint && !isLoopbackHost(hint)) return hint.replace(/^\[|\]$/g, "");
  const addresses = Object.values(interfaces)
    .flat()
    .filter(
      (entry): entry is os.NetworkInterfaceInfo =>
        Boolean(entry) && !entry!.internal && entry!.family === "IPv4"
    )
    .map((entry) => entry.address)
    .filter((address) => !address.startsWith("169.254."));
  const isPrivate = (address: string) =>
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
  return (
    addresses.find(isPrivate) ??
    addresses[0] ??
    (isLoopbackHost(hostname) ? "localhost" : hostname)
  );
}
