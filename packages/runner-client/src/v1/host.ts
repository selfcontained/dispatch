/*
 * Wire v1 host frames behind the `session.attach` channel. A v1 host names
 * its agent in `welcome`, in every journaled event and in MCP inventory
 * results; the contract channel is the session, so decoding drops that id
 * and encoding restores it. Client frames are the same on both sides.
 */
import type {
  Infer,
  clientMessage,
  hostMessage,
} from "@dispatch/runner-protocol/contract";

export type ClientMessage = Infer<typeof clientMessage>;
export type HostMessage = Infer<typeof hostMessage>;

type AnyRecord = Record<string, unknown>;

const withoutAgent = ({ agentId: _, ...rest }: AnyRecord) => rest;

/** A v1 host frame as the contract message. */
export function decodeHostFrame(frame: AnyRecord): HostMessage {
  switch (frame.type) {
    case "welcome":
      return withoutAgent(frame) as HostMessage;
    case "event":
      return {
        ...frame,
        event: withoutAgent(frame.event as AnyRecord),
      } as HostMessage;
    case "mcp_inventory_result":
      return {
        ...frame,
        result: withoutAgent(frame.result as AnyRecord),
      } as HostMessage;
    default:
      return frame as HostMessage;
  }
}

/** A contract message as the v1 host frame for the session's agent. */
export function encodeHostFrame(
  message: HostMessage,
  agentId: string
): AnyRecord {
  switch (message.type) {
    case "welcome":
      return { ...message, agentId };
    case "event": {
      // v1 hosts write the agent id right after the event type.
      const { type, ...event } = message.event;
      return { ...message, event: { type, agentId, ...event } };
    }
    case "mcp_inventory_result":
      return { ...message, result: { agentId, ...message.result } };
    default:
      return message;
  }
}
