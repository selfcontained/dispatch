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
