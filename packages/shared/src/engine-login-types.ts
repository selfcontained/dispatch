export {
  LOGIN_ENGINES,
  isLoginEngine,
} from "@dispatch/runner-protocol/engine-sign-in";
export type {
  EngineLoginEngine,
  EngineLogin,
  EngineAuthStatus,
} from "@dispatch/runner-protocol/engine-sign-in";

/**
 * The `errorKind` a turn carries when the engine's sign-in has lapsed; the
 * turn offers a sign-in in place of a retry.
 */
export const AUTHENTICATION_REQUIRED = "authentication_required";
