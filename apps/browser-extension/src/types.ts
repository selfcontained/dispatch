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

export interface ConnectionStatus {
  connected: boolean;
  baseUrl?: string;
}

export interface WorkerResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  submissionTerminalFailure?: boolean;
}
