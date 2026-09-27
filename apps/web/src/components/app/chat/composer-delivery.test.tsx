// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { recipientTimings, type DeliveryAgent } from "./composer-delivery";

const conversation = { streamId: "root", threadId: "a" };
const recipients = [{ id: "agent", name: "Agent" }];
function timing(inputState: DeliveryAgent["inputState"], queue = false) {
  return recipientTimings(
    recipients,
    [
      {
        id: "agent",
        inputState,
        currentTurn: { blockId: "stale", threadId: "a", streamId: "root" },
        activity: "working",
      } as DeliveryAgent,
    ],
    conversation,
    queue ? "queue" : "auto"
  )[0]!;
}

describe("recipient timing", () => {
  it("prefers live runtime identity over a stale persisted current turn", () => {
    expect(
      timing({
        active: true,
        steeringSupported: true,
        conversation: { ...conversation, threadId: "b" },
      }).timing
    ).toBe("Queued");
    expect(
      timing(
        { active: false, steeringSupported: true, conversation: null },
        true
      )
    ).toMatchObject({ busy: false, timing: "Now" });
  });
  it("shows Queued for unsupported hosts and unknown active conversations", () => {
    expect(
      timing({ active: true, steeringSupported: false, conversation }).timing
    ).toBe("Queued");
    expect(
      timing({ active: true, steeringSupported: true, conversation: null })
        .timing
    ).toBe("Queued");
    expect(
      timing({ active: true, steeringSupported: true, conversation }).timing
    ).toBe("Now");
  });
  it("queues without live inputState even when the persisted conversation matches", () => {
    expect(timing(undefined)).toMatchObject({ busy: true, timing: "Queued" });
    expect(
      recipientTimings(
        recipients,
        [
          {
            id: "agent",
            activity: "working",
            currentTurn: { blockId: "old", threadId: "a" },
          },
        ],
        conversation,
        "auto"
      )[0]?.timing
    ).toBe("Queued");
  });

  it("interrupts supported busy recipients and starts idle recipients normally", () => {
    const agents = [
      {
        id: "a",
        inputState: {
          active: true,
          steeringSupported: false,
          interruptSupported: true,
          conversation: null,
        },
      },
      {
        id: "b",
        inputState: {
          active: false,
          steeringSupported: false,
          conversation: null,
        },
      },
      {
        id: "c",
        inputState: { active: true, steeringSupported: true, conversation },
      },
    ] as DeliveryAgent[];
    const timings = recipientTimings(
      agents.map(({ id }) => ({ id, name: id })),
      agents,
      conversation,
      "interrupt",
      true
    );
    expect(timings.map(({ timing }) => timing)).toEqual([
      "Interrupt",
      "Now",
      "Unavailable",
    ]);
    expect(timings[0]?.reason).toBe("Stop current turn, then respond here.");
    expect(timings[1]?.reason).toBe("Ready for a new turn.");
    expect(timings[2]?.reason).toContain("does not support interrupting");
  });

  it("keeps timing independent for each recipient and stream", () => {
    const agents = [
      {
        id: "a",
        inputState: { active: true, steeringSupported: true, conversation },
      },
      {
        id: "b",
        inputState: {
          active: true,
          steeringSupported: true,
          conversation: { ...conversation, streamId: "elsewhere" },
        },
      },
      {
        id: "c",
        inputState: {
          active: false,
          steeringSupported: true,
          conversation: null,
        },
      },
    ] as DeliveryAgent[];
    const recipients = agents.map(({ id }) => ({ id, name: id }));
    expect(
      recipientTimings(recipients, agents, conversation, "auto").map(
        (item) => item.timing
      )
    ).toEqual(["Now", "Queued", "Now"]);
    expect(
      recipientTimings(recipients, agents, conversation, "queue").map(
        (item) => item.timing
      )
    ).toEqual(["Queued", "Queued", "Now"]);
  });
});
