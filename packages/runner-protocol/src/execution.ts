import { MANAGED_WORKSPACE, isOpaqueId } from "./placement.js";
import type {
  EngineInventoryEntry,
  EngineOperation,
} from "./engine-management.js";
import type { RunnerHealth } from "./health.js";

export const RUNNER_WIRE_VERSION = 1;

export type RunnerEngine = "claude" | "codex" | "opencode";

export type ServiceMcp = {
  url: string;
  token: string;
  /** Legacy launchers omit the name and use "dispatch". */
  name?: string;
};

export type RepositoryCheckout =
  | { kind: "new"; branch: string; base?: string }
  | { kind: "branch"; branch: string }
  | { kind: "pr"; branch: string; number: number };

export type RunnerRepository = { url: string; checkout: RepositoryCheckout };

/** The guest supplies all machine-local execution settings. */
export type RemoteLaunch = {
  agentId: string;
  engine: RunnerEngine;
  fullAccess?: boolean;
  model: string | null;
  effort?: string | null;
  systemPrompt: string | null;
  personaContext?: string | null;
  mcp?: ServiceMcp;
  resumeSessionId: string | null;
  repository?: RunnerRepository;
};

export type Command = { agentId: string; workspace: string } & (
  | { kind: "launch"; launch: RemoteLaunch }
  | { kind: "attach" | "alive" | "discard" | "log" | "repo" }
  | { kind: "stop"; force: boolean }
  /**
   * Runner-wide engine install/update/sign-in — not bound to any agent or
   * workspace binding; the runner answers it before any agent-binding
   * checks. `workspace` only needs to name one of the runner's online
   * workspaces, for routing. A runner that predates this never answers it,
   * so the reply handler (service.ts, RunnerEngineTransport) treats a lost
   * acknowledgement or error as `unsupported`.
   */
  | { kind: "engine"; operation: EngineOperation }
);
export type ReadyFrame = {
  type: "ready";
  version: typeof RUNNER_WIRE_VERSION;
  workspaces: string[];
  health?: true;
  managedWorkspace?: true;
  /** Advertises support for the `"engine"` command and inventory push. */
  engineManagement?: true;
};

/** Accept v1 extension fields and enable optional features only when explicitly true. */
export function parseReadyFrame(value: unknown): ReadyFrame | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  if (
    frame.type !== "ready" ||
    frame.version !== RUNNER_WIRE_VERSION ||
    !Array.isArray(frame.workspaces) ||
    frame.workspaces.length > 256 ||
    !frame.workspaces.every(isOpaqueId) ||
    (frame.managedWorkspace !== undefined &&
      (frame.managedWorkspace !== true ||
        frame.workspaces.length !== 1 ||
        frame.workspaces[0] !== MANAGED_WORKSPACE))
  )
    return null;
  return {
    type: "ready",
    version: RUNNER_WIRE_VERSION,
    workspaces: frame.workspaces,
    ...(frame.health === true && { health: true }),
    ...(frame.engineManagement === true && { engineManagement: true }),
    ...(frame.managedWorkspace === true && { managedWorkspace: true }),
  };
}

export type ChannelFrame =
  | { type: "data"; id: string; data: string }
  | { type: "close"; id: string };

export type ServiceFrame =
  | { type: "accept_health"; engineInventory?: true }
  | { type: "request"; id: string; command: Command }
  | ChannelFrame;

export type ResultFrame = {
  type: "result";
  id: string;
  value?: boolean | string;
  error?: string;
  code?: "host-gone";
};

export type RunnerFrame =
  | ReadyFrame
  | { type: "health"; sample: RunnerHealth }
  | { type: "engine_inventory"; entries: EngineInventoryEntry[] }
  | ResultFrame
  | ChannelFrame;

export type Frame = ServiceFrame | RunnerFrame;
