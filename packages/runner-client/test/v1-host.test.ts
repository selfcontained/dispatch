import {
  clientMessage,
  hostMessage,
  operations,
} from "@dispatch/runner-protocol/contract";
import { describe, expect, it } from "vitest";
import { decodeHostFrame, encodeHostFrame } from "../src/v1/host.js";
import { agentId, clientFrames, hostFrames } from "./v1-host-fixtures.js";

const attach = operations["session.attach"].channel;

describe("wire v1 session host frames", () => {
  it("the attach channel is the typed host vocabulary", () => {
    expect(attach.toRunner).toBe(clientMessage);
    expect(attach.fromRunner).toBe(hostMessage);
  });

  it.each(clientFrames.map((frame) => [frame.type, frame] as const))(
    "client %s is a contract message",
    (_type, frame) => expect(clientMessage.check(frame)).toBe(true)
  );

  it.each(hostFrames.map((frame, i) => [frame.type, i, frame] as const))(
    "host %s (#%i) decodes without the agent id and round-trips",
    (_type, _i, frame) => {
      const message = decodeHostFrame(frame);
      expect(hostMessage.check(message)).toBe(true);
      expect(JSON.stringify(message)).not.toContain(agentId);
      // Same fields and values; JSON key order carries no meaning on v1.
      expect(encodeHostFrame(message, agentId)).toStrictEqual(frame);
    }
  );

  it("rejects frames outside the vocabulary", () => {
    expect(hostMessage.check({ type: "welcome" })).toBe(false);
    expect(
      hostMessage.check({ type: "event", seq: 1, at: "", event: { type: "x" } })
    ).toBe(false);
    expect(clientMessage.check({ type: "prompt", id: "p" })).toBe(false);
  });
});
