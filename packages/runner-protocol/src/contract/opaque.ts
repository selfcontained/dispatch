import type { Schema } from "./schema.js";

/*
 * Opaque values. On the wire each is a plain string (a placement is
 * `{runner}`), but at the type level each is a non-string object, so a
 * runner path cannot be passed to `fs` or `path`, and a session handle or
 * placement cannot be compared with a literal. The functions below are the
 * only conversions; boundary rules decide who may call them.
 */

declare const opaque: unique symbol;
export type Opaque<Name extends string> = { readonly [opaque]: Name };

/** A handle chosen by the caller for one agent session. Never interpreted by the runner. */
export type SessionHandle = Opaque<"SessionHandle">;
/** A path meaningful only on the runner that returned it. */
export type RunnerPath = Opaque<"RunnerPath">;
/** The identity of one runner. */
export type RunnerId = Opaque<"RunnerId">;
/** Where an agent runs. Never null; there are no workspaces. */
export type Placement = Opaque<"Placement">;

function opaqueString<T>(name: string): Schema<T> {
  return {
    shape: { opaque: name },
    check: (value: unknown): value is T => typeof value === "string",
  };
}

export const sessionHandle = opaqueString<SessionHandle>("SessionHandle");
export const runnerPath = opaqueString<RunnerPath>("RunnerPath");
export const runnerId = opaqueString<RunnerId>("RunnerId");

/* Wire codecs. A cast elsewhere is a boundary violation. */
export const sessionFromWire = (value: string) =>
  value as unknown as SessionHandle;
export const sessionToWire = (value: SessionHandle) =>
  value as unknown as string;
export const pathFromWire = (value: string) => value as unknown as RunnerPath;
/** The only conversion of a runner path to text: for display and serialisation, never for opening. */
export const displayPath = (value: RunnerPath) => value as unknown as string;
export const runnerIdFromWire = (value: string) => value as unknown as RunnerId;
export const runnerIdToWire = (value: RunnerId) => value as unknown as string;

export function placementOf(runner: RunnerId): Placement {
  return Object.freeze({ runner }) as unknown as Placement;
}
export function placementRunner(placement: Placement): RunnerId {
  return (placement as unknown as { runner: RunnerId }).runner;
}
export function sameRunner(a: Placement, b: Placement): boolean {
  return placementRunner(a) === placementRunner(b);
}
/** Placements are `{runner}` only, so equal placements are the same runner. */
export const samePlacement = sameRunner;
