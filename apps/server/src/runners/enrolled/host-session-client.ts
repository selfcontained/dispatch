import {
  HostClient,
  type HostClientDeps,
  UpdateAcknowledgementLost,
} from "@dispatch/runner-client/host-client";
import { isPromptSource } from "../../agents/acp/prompt-source.js";

export type { HostQuiesceLease } from "@dispatch/runner-client/host-client";
export type HostSessionClient = HostClient;

export function createHostSessionClient(
  options: Omit<HostClientDeps, "validSource">
): HostSessionClient {
  return new HostClient({ validSource: isPromptSource, ...options });
}

export function isUpdateAcknowledgementLost(
  error: unknown
): error is UpdateAcknowledgementLost {
  return error instanceof UpdateAcknowledgementLost;
}
