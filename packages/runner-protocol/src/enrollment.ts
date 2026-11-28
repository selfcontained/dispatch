import { isOpaqueId } from "./placement.js";
import { isHttpUrl, isRecord } from "./validation.js";

/** Public bootstrap messages on the runner TLS listener, before agent traffic. */
export type EnrollmentRequest =
  | { type: "ca_request"; version: 1 }
  | { type: "enroll"; version: 1; code: string; publicKey: string };

export type EnrollmentReply =
  | { type: "ca"; ca: string }
  | { type: "enrolled"; id: string; name: string; cert: string; ca: string }
  | { type: "enroll_error"; error: string };

/** Responses from the service's HTTPS connection-request and polling routes. */
export type ConnectCreated = {
  id: string;
  code: string;
  expiresAt: string;
  /** Optional link for the operator who approves the request. */
  approveUrl?: string;
};
export type ConnectPoll =
  | { status: "pending" }
  | {
      status: "approved";
      id: string;
      name: string;
      endpoint: string;
      cert: string;
      ca: string;
    }
  | { status: "denied" }
  | { status: "expired" };

function isConnectCreated(value: unknown): value is ConnectCreated {
  return (
    isRecord(value) &&
    isOpaqueId(value.id) &&
    value.id !== "." &&
    value.id !== ".." &&
    isOpaqueId(value.code) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    !/[\x00-\x1f\x7f-\x9f]/u.test(value.expiresAt) &&
    (value.approveUrl === undefined || isHttpUrl(value.approveUrl, true))
  );
}

function isConnectPoll(value: unknown): value is ConnectPoll {
  if (!isRecord(value)) return false;
  switch (value.status) {
    case "pending":
    case "denied":
    case "expired":
      return true;
    case "approved":
      return (
        isOpaqueId(value.id) &&
        isOpaqueId(value.name) &&
        isHttpUrl(value.endpoint) &&
        typeof value.cert === "string" &&
        value.cert.trim().length > 0 &&
        typeof value.ca === "string" &&
        value.ca.trim().length > 0
      );
    default:
      return false;
  }
}

export function parseConnectCreated(value: unknown): ConnectCreated | null {
  return isConnectCreated(value) ? value : null;
}

export function parseConnectPoll(value: unknown): ConnectPoll | null {
  return isConnectPoll(value) ? value : null;
}

/** Normalize `AB:CD:…` and bare hex to the colon form Node reports. */
export function normalizeFingerprint(value: string) {
  const hex = value.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  if (hex.length !== 64) throw new Error("Expected a SHA-256 fingerprint");
  return hex.match(/../g)!.join(":");
}

/** Display names only; placements address runners by registration id. */
export function validRunnerName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name === name.trim() &&
    name.length > 0 &&
    name.length <= 64 &&
    !/[\x00-\x1f\x7f-\x9f]/u.test(name)
  );
}

export function formatEnrollmentHost(host: string, ipVersion: number) {
  return ipVersion === 6 ? `[${host}]` : host;
}

export function formatPairingCommand(input: {
  host: string;
  port: number;
  caFingerprint: string;
  code: string;
}) {
  const pin = normalizeFingerprint(input.caFingerprint)
    .replace(/:/g, "")
    .toLowerCase();
  return [
    "dispatch-runner remote-runner-pair",
    `--endpoint https://${input.host}:${input.port}`,
    `--ca-sha256 ${pin}`,
    `--code ${input.code}`,
  ].join(" ");
}

/**
 * Unlike `pairingCommand`, this is not single-use: the runner supplies its
 * own one-time code at connect time, so the same invocation can be copied
 * onto any number of clean runners. The target is always this listener's
 * own pinned CA and port — reachable and verifiable even when the ordinary
 * Dispatch API is loopback-only or plain HTTP, since nothing about it
 * depends on the main API's own binding or certificate.
 */
export function formatConnectCommand(
  input: {
    host: string;
    port: number;
    caFingerprint: string;
  },
  encodePin: (hex: string) => string
) {
  const pin = normalizeFingerprint(input.caFingerprint).replace(/:/g, "");
  const service = new URL(`https://${input.host}:${input.port}`);
  // The fragment conveys trust from Settings and is never sent over HTTP.
  service.hash = `sha256=${encodePin(pin)}`;
  return `sudo dispatch-runner connect '${service.href}'`;
}
