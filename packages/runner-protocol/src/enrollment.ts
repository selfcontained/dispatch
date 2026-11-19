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
