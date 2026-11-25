import { personaScopeFor as scopeFor } from "../../src/personas/persona-scope.js";
export * from "../../src/personas/persona-scope.js";
type Target = Parameters<typeof scopeFor>[0];
type Folder = Extract<Target, { runners: unknown }>;
/** Explicit local runner wiring for the test-only bare folder constructor. */
export function personaScopeFor(
  target:
    | Exclude<Target, Folder>
    | (Omit<Folder, "runners"> & { runners?: Folder["runners"] })
) {
  return scopeFor(
    "agent" in target
      ? target
      : { ...target, runners: target.runners ?? (() => ({})) }
  );
}
