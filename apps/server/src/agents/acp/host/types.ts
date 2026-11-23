/*
 * The host's own names for what it reports, taken from the session
 * contract rather than from any one caller's model. A caller with its own
 * types (Dispatch's `@dispatch/shared`) receives the same shapes.
 */
import type { PromptImage as WirePromptImage } from "@dispatch/runner-protocol";
import type {
  Infer,
  hostMessage,
  permissionRequest,
} from "@dispatch/runner-protocol/contract";

type ResultOf<T extends HostMessage["type"]> = Extract<
  HostMessage,
  { type: T; result: unknown }
>["result"];
type HostMessage = Infer<typeof hostMessage>;

/** A live engine request for permission, held by the host until answered. */
export type PermissionRequest = Infer<typeof permissionRequest>;

/** A live snapshot of the engine's background work. */
export type BackgroundSnapshot = ResultOf<"background_work_result">;
export type BackgroundItem = BackgroundSnapshot["items"][number];

/** A v1 host names its agent in every inventory result. */
export type McpInventoryResult = ResultOf<"mcp_inventory_result"> & {
  agentId: string;
};
export type McpInventory = NonNullable<McpInventoryResult["inventory"]>;

/** An engine effort level, as the engine names it. */
export type Effort = string;

/** The `errorKind` a turn carries when the engine's sign-in has lapsed. */
export const AUTHENTICATION_REQUIRED = "authentication_required";

/**
 * A caller's metadata for a prompt: the host keeps it with the turn and
 * hands it back on the turn's events, and never reads it. A caller that
 * wants it typed augments this interface with `{ source: T }`.
 */
export interface CallerSourceRegistry {}
export type CallerSource = CallerSourceRegistry extends { source: infer S }
  ? S
  : unknown;

/** A prompt attachment. A runner name marks an input to stage before ACP submission. */
export type PromptImage = WirePromptImage & { runnerName?: string };

/**
 * How the host finds engine CLIs and extends the engine's PATH. The caller
 * that starts the host supplies these; the host has no defaults.
 */
export type HostSearchPath = {
  /** Add the usual CLI install locations after the PATH the host built. */
  withToolSearchPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Add the launched engine CLI's own directory, last. */
  withEngineBinDir(
    searchPath: string | undefined,
    bin: string | null | undefined
  ): string;
  /** A package manager's bin directory, skipped when looking up a CLI. */
  isPackageBinDir(dir: string): boolean;
};
