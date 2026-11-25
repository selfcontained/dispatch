export { AUTHENTICATION_REQUIRED } from "@dispatch/runner-protocol/host";
export type {
  BackgroundSnapshot,
  BackgroundItem,
  Effort,
  McpInventoryResult,
  McpInventory,
  PermissionRequest,
  PromptImage,
  CallerSource,
  CallerSourceRegistry,
} from "@dispatch/runner-protocol/host";

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
