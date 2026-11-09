import type { PromptConversation } from "@dispatch/shared";

export type SteeringChoice =
  | "steer_current"
  | "queue_next"
  | "keep_existing_default";
export type SteeringOutcome =
  | "steered"
  | "queued"
  | "default"
  | "expired"
  | "overridden"
  | "declined"
  | "failed";
export type SteeringDecision = {
  choice: SteeringChoice;
  /** A settings change invalidates decisions not yet submitted. */
  valid: () => boolean;
  finish: (outcome: SteeringOutcome) => void;
};
export type ClassifySteering = (input: {
  agentId: string;
  messageId: string;
  turnSeq: number;
  activeMessageIds: string[];
  conversation: PromptConversation;
  defaultSteers: boolean;
  signal: AbortSignal;
}) => Promise<SteeringDecision | undefined>;
