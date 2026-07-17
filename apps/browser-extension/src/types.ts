export interface PageContext {
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
  };
  devicePixelRatio: number;
}

export interface DomElementSummary {
  tagName: string;
  selector: string;
  id: string | null;
  classes: string[];
  role: string | null;
  accessibleName: string | null;
  text: string;
}

export interface AncestorElementSummary extends DomElementSummary {
  /** One is the selected element's parent. */
  depth: number;
}

export interface NearbyElementSummary extends DomElementSummary {
  relation: "previous-sibling" | "next-sibling";
  /** Zero is relative to the selection; higher values are its ancestors. */
  relativeToDepth: number;
}

export interface ElementContext {
  tagName: string;
  selector: string;
  xpath: string;
  id: string | null;
  classes: string[];
  role: string | null;
  accessibleName: string | null;
  text: string;
  outerHtml: string;
  ancestors: AncestorElementSummary[];
  nearbyElements: NearbyElementSummary[];
  searchHints: string[];
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface BrowserSelection {
  page: PageContext;
  element: ElementContext;
}

export interface DispatchAgent {
  id: string;
  name: string;
  status: string;
  repoName?: string;
  branch?: string;
}

export type WorkerRequest =
  | { type: "connection:status" }
  | { type: "connection:disconnect" }
  | { type: "pairing:start"; baseUrl: string }
  | {
      type: "pairing:exchange";
      baseUrl: string;
      pairingId: string;
      pairingSecret: string;
    }
  | { type: "agents:list" }
  | {
      type: "submission:create";
      clientSubmissionId: string;
      agentId: string;
      comment: string;
      selection: BrowserSelection;
    };

const WORKER_REQUEST_TYPES = {
  "connection:status": true,
  "connection:disconnect": true,
  "pairing:start": true,
  "pairing:exchange": true,
  "agents:list": true,
  "submission:create": true,
} satisfies Record<WorkerRequest["type"], true>;

export function isWorkerRequest(request: unknown): request is WorkerRequest {
  return (
    typeof request === "object" &&
    request !== null &&
    "type" in request &&
    typeof request.type === "string" &&
    Object.hasOwn(WORKER_REQUEST_TYPES, request.type)
  );
}

/**
 * Safari-only requests handled by src/safari/background.ts. Kept as a separate
 * union so the shared worker-core switch over WorkerRequest stays exhaustive.
 */
export type SafariRequest =
  | { type: "pairing:begin"; baseUrl: string }
  | { type: "pairing:status" }
  | { type: "pairing:cancel" }
  | { type: "picker:arm" }
  | { type: "picker:disarm" }
  | { type: "overlay:init"; origin: string }
  | { type: "agent:remember"; origin: string; agentId: string }
  | {
      type: "overlay:closed";
      reason: "submitted" | "cancelled" | "failed";
    };

const SAFARI_REQUEST_TYPES = {
  "pairing:begin": true,
  "pairing:status": true,
  "pairing:cancel": true,
  "picker:arm": true,
  "picker:disarm": true,
  "overlay:init": true,
  "agent:remember": true,
  "overlay:closed": true,
} satisfies Record<SafariRequest["type"], true>;

export function isSafariRequest(request: unknown): request is SafariRequest {
  return (
    typeof request === "object" &&
    request !== null &&
    "type" in request &&
    typeof request.type === "string" &&
    Object.hasOwn(SAFARI_REQUEST_TYPES, request.type)
  );
}

export type PairingSessionState =
  | { state: "idle" }
  | { state: "pending"; baseUrl: string; code: string; expiresAt: string }
  | { state: "approved"; baseUrl: string }
  | { state: "expired" };

export type ArmFailureCode =
  | "no-site-access"
  | "unsupported-page"
  | "inject-failed";

export interface OverlayInitData {
  connected: boolean;
  baseUrl?: string;
  agents: DispatchAgent[];
  selectedAgentId: string | null;
}

export interface ConnectionStatus {
  connected: boolean;
  baseUrl?: string;
}

export interface WorkerResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  submissionTerminalFailure?: boolean;
  /** Set on failed Safari picker:arm responses to select the guidance shown. */
  code?: ArmFailureCode;
}
