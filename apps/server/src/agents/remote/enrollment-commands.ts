import { isIP } from "node:net";
import {
  formatEnrollmentHost,
  formatPairingCommand,
  formatConnectCommand,
} from "@dispatch/runner-protocol";
export { validRunnerName } from "@dispatch/runner-protocol";
export function formatHost(host: string) {
  return formatEnrollmentHost(host, isIP(host));
}
export function pairingCommand(
  input: Parameters<typeof formatPairingCommand>[0]
) {
  return formatPairingCommand({ ...input, host: formatHost(input.host) });
}
export function connectCliCommand(
  input: Parameters<typeof formatConnectCommand>[0]
) {
  return formatConnectCommand(
    { ...input, host: formatHost(input.host) },
    (hex) => Buffer.from(hex, "hex").toString("base64url")
  );
}
