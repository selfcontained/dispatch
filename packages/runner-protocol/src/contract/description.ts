import { runnerId } from "./opaque.js";
import {
  array,
  integer,
  literal,
  object,
  optional,
  string,
  type Infer,
} from "./schema.js";
import { build } from "./types.js";

/**
 * Optional capabilities. Everything else is baseline. Adding one changes the
 * surface snapshot. The only optional capability is `selfUpdate`.
 */
export const selfUpdateCapability = object({
  protocol: integer,
  os: string,
  arch: string,
  version: string,
  revision: string,
  installedSha256: string,
  handoff: object({ reads: array(integer), writes: integer }),
  pendingAttemptId: optional(string),
  fenceUnreadable: optional(literal(true)),
});

/**
 * What a runner says about itself. Deliberately no field that says local or
 * remote, and no OS, transport, limits or workspaces.
 */
export const runnerDescription = object({
  runnerId,
  displayName: string,
  build,
  protocol: integer,
  engines: array(string),
  capabilities: object({ selfUpdate: optional(selfUpdateCapability) }),
});

export type RunnerDescription = Infer<typeof runnerDescription>;
