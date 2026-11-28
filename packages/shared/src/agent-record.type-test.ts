import type { AgentRecord } from "./agent-record.js";

type AssertAgent<T extends AgentRecord> = T;
type WithoutPlacement = Omit<AgentRecord, "placement">;

// @ts-expect-error A persisted agent must have a placement.
export type MissingPlacement = AssertAgent<WithoutPlacement>;
// @ts-expect-error The placement must identify a runner.
export type NullPlacement = AssertAgent<WithoutPlacement & { placement: null }>;
