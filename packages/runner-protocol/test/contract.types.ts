/* Compile-time checks of the contract. Run by `tsc -p tsconfig.test.json` in `check`. */
import type { PathLike } from "node:fs";
import {
  pathFromWire,
  type CallerChannel,
  type CallName,
  type Handler,
  type Infer,
  type Runner,
  type clientMessage,
  type hostMessage,
  type OpenName,
  type Placement,
  type Req,
  type Res,
  type RunnerHandlers,
  type RunnerPath,
} from "../src/contract/index.js";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// Open operations are exactly the ones that return a channel.
export type OpenOps = Assert<
  Equal<
    OpenName,
    "session.attach" | "terminal.open" | "checkout.watch" | "port.connect"
  >
>;
export type LaunchIsCall = Assert<
  "session.launch" extends CallName ? true : false
>;

// Request and response types derive from the table.
export type LaunchKey = Assert<
  Equal<Req<"session.launch">["launchId"], string>
>;
export type AliveState = Assert<
  Equal<Res<"session.alive">["state"], "live" | "gone" | "stale">
>;
export type OptionalModel = Assert<
  Equal<Req<"engine.models">, { engine: string; model?: string }>
>;

// Release takes removal inputs, not the pre-P7 state gate (C1).
export type ReleaseHasNoState = Assert<
  "expectedState" extends keyof Req<"workspace.release"> ? false : true
>;
export type ReleaseRemoved = Assert<
  Equal<Res<"workspace.release">, { removed: boolean }>
>;
// A worktree's nested location names its directory (C2).
export type NestedLocation = Assert<
  Equal<
    NonNullable<Req<"workspace.prepare">["worktree"]>["location"],
    "sibling" | { nested: string } | undefined
  >
>;

// The attach channel carries typed host messages; byte channels stay bytes (T04b).
type ClientMessage = Infer<typeof clientMessage>;
type HostMessage = Infer<typeof hostMessage>;
type AttachCtx = Parameters<Handler<"session.attach">>[1]["channel"];
declare const runner: Runner;
const attach = () => runner.open("session.attach", null as never);
type AttachOpen = Awaited<ReturnType<typeof attach>>["channel"];
export type HandlerWritesHost = Assert<
  Equal<Parameters<AttachCtx["write"]>[0], HostMessage>
>;
export type HandlerReadsClient = Assert<
  Equal<Parameters<Parameters<AttachCtx["onData"]>[0]>[0], ClientMessage>
>;
export type CallerWritesClient = Assert<
  Equal<Parameters<CallerChannel<"session.attach">["write"]>[0], ClientMessage>
>;
export type OpenReadsHost = Assert<
  Equal<Parameters<Parameters<AttachOpen["onData"]>[0]>[0], HostMessage>
>;
export type PortIsBytes = Assert<
  Equal<Parameters<CallerChannel<"port.connect">["write"]>[0], Uint8Array>
>;
export type EventHasNoSession = Assert<
  "agentId" extends keyof Extract<HostMessage, { type: "event" }>["event"]
    ? false
    : true
>;

// A handler map that omits an operation does not compile.
// @ts-expect-error: "port.connect" and every other operation are missing.
export const incomplete: RunnerHandlers = {
  "runner.describe": async () => {
    throw new Error();
  },
};

// A runner path is not a file-system path, and a placement is not a string.
const path: RunnerPath = pathFromWire("/tmp");
// @ts-expect-error: RunnerPath is opaque.
export const asFsPath: PathLike = path;
// @ts-expect-error: Placement is opaque.
export const asText: string = null as unknown as Placement;
