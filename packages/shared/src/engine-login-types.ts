/** The engines Dispatch can sign in from the browser. */
export type EngineLoginEngine = "claude" | "codex";

/**
 * The `errorKind` a turn carries when the engine's sign-in has lapsed; the
 * turn offers a sign-in in place of a retry.
 */
export const AUTHENTICATION_REQUIRED = "authentication_required";

/**
 * A sign-in the server is running for an engine's CLI. `waiting` carries the
 * link to open (and Codex's one-time code); a Claude login then wants the
 * code its sign-in page shows, posted back with `needsCode`.
 */
export type EngineLogin = {
  id: string;
  engine: EngineLoginEngine;
  status:
    | "starting"
    | "waiting"
    | "verifying"
    | "succeeded"
    | "failed"
    | "cancelled";
  url?: string;
  /** Codex: the code to enter on the sign-in page. */
  userCode?: string;
  /** Claude: the sign-in page shows a code that has to come back here. */
  needsCode: boolean;
  /** Who it signed in as, or how, once it has. */
  detail?: string;
  error?: string;
  expiresAt: string;
  /** When it ended; absent while it is under way. */
  finishedAt?: string;
};

export type EngineAuthStatus = {
  engine: EngineLoginEngine;
  installed: boolean;
  signedIn: boolean;
  /** The account (Claude's email) or how it signed in (Codex). */
  detail?: string;
};
