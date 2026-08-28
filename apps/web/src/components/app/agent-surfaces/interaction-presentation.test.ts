import { describe, expect, it } from "vitest";

import {
  findInteraction,
  indexInteractions,
  isPendingStatus,
  resolveInteractionPresentation,
  type InteractionMode,
} from "./interaction-presentation";
import type { LocalInteractionState } from "./local-interaction-state";
import type { SurfaceInteractionSummary } from "@/components/app/agent-surfaces/types";

function summary(
  overrides: Partial<SurfaceInteractionSummary> = {}
): SurfaceInteractionSummary {
  return {
    id: "ix_1",
    tabRevision: 1,
    blockId: "block-1",
    actionId: "go",
    kind: "action",
    status: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const IDLE: LocalInteractionState = { status: "idle" };

function resolve({
  local = IDLE,
  durable,
  surfaceRevision = 1,
  mode = "action",
  readOnly = false,
}: {
  local?: LocalInteractionState;
  durable?: SurfaceInteractionSummary;
  surfaceRevision?: number;
  mode?: InteractionMode;
  readOnly?: boolean;
}) {
  return resolveInteractionPresentation({
    local,
    durable,
    surfaceRevision,
    mode,
    readOnly,
  });
}

describe("isPendingStatus", () => {
  it("treats only the three unresolved server statuses as pending", () => {
    expect(isPendingStatus("queued")).toBe(true);
    expect(isPendingStatus("notified")).toBe(true);
    expect(isPendingStatus("claimed")).toBe(true);
    expect(isPendingStatus("completed")).toBe(false);
    expect(isPendingStatus("rejected")).toBe(false);
    expect(isPendingStatus("cancelled")).toBe(false);
    expect(isPendingStatus("orphaned")).toBe(false);
  });
});

describe("resolveInteractionPresentation — in-flight and idle", () => {
  it("shows the spinner and locks while this tab's POST is in flight", () => {
    expect(resolve({ local: { status: "submitting" } })).toEqual({
      busy: true,
      locked: true,
      caption: null,
    });
  });

  it("renders nothing for an untouched control with no durable record", () => {
    expect(resolve({})).toEqual({ busy: false, locked: false, caption: null });
  });

  it("locks an untouched control on a frozen surface without inventing a caption", () => {
    expect(resolve({ readOnly: true })).toEqual({
      busy: false,
      locked: true,
      caption: null,
    });
  });
});

describe("resolveInteractionPresentation — durable pending hydration (#2016)", () => {
  it.each([
    ["queued", "Queued"],
    ["notified", "Sent to the agent"],
    ["claimed", "In progress"],
  ] as const)(
    "hydrates a %s record as locked with a leading %s label, with no local state at all",
    (status, label) => {
      const result = resolve({ durable: summary({ status }) });
      expect(result.locked).toBe(true);
      expect(result.busy).toBe(false);
      expect(result.caption).toMatchObject({ kind: "pending", status, label });
    }
  );

  it("stays locked regardless of how far the document revision has moved on", () => {
    // Interaction changes emit SSE but never bump the surface revision, so a
    // pending record must not be re-armed by an unrelated document edit.
    expect(
      resolve({
        durable: summary({ status: "queued", tabRevision: 1 }),
        surfaceRevision: 9,
      }).locked
    ).toBe(true);
  });

  it("keeps a repeatable form locked while its own submission is still pending", () => {
    expect(
      resolve({
        durable: summary({ status: "claimed" }),
        mode: "form-repeatable",
      }).locked
    ).toBe(true);
  });

  it("outranks a local POST error, so a lost response cannot cause a duplicate submission", () => {
    const result = resolve({
      local: { status: "error", message: "network down" },
      durable: summary({ status: "queued" }),
    });
    expect(result.locked).toBe(true);
    expect(result.caption).toMatchObject({ kind: "pending", status: "queued" });
  });
});

describe("resolveInteractionPresentation — outcomes reach the user (#2015)", () => {
  it("surfaces the agent's outcomeMessage for a completed interaction", () => {
    expect(
      resolve({
        durable: summary({
          status: "completed",
          outcomeMessage: "Access granted.",
        }),
      }).caption
    ).toEqual({
      kind: "outcome",
      status: "completed",
      label: "Completed",
      tone: "success",
      message: "Access granted.",
    });
  });

  it("shows a rejection reason in the danger tone", () => {
    expect(
      resolve({
        durable: summary({
          status: "rejected",
          outcomeMessage: "Not enough context.",
        }),
      }).caption
    ).toEqual({
      kind: "outcome",
      status: "rejected",
      label: "Declined",
      tone: "danger",
      message: "Not enough context.",
    });
  });

  it.each([
    ["rejected", "Declined", "the agent declined this"],
    ["cancelled", "Cancelled", "this was cancelled"],
    ["orphaned", "Not handled", "the agent ended before handling this"],
  ] as const)(
    "falls back to explanatory copy when %s carries no outcomeMessage",
    (status, label, fallback) => {
      expect(resolve({ durable: summary({ status }) }).caption).toMatchObject({
        label,
        message: fallback,
      });
    }
  );

  it("leaves a bare completed caption with no invented message", () => {
    const caption = resolve({
      durable: summary({ status: "completed" }),
    }).caption;
    expect(caption).toEqual({
      kind: "outcome",
      status: "completed",
      label: "Completed",
      tone: "success",
    });
  });

  it("still reports the outcome on a frozen surface, even though nothing can be retried", () => {
    const result = resolve({
      durable: summary({ status: "rejected", outcomeMessage: "Too risky." }),
      readOnly: true,
    });
    expect(result.locked).toBe(true);
    expect(result.caption).toMatchObject({ message: "Too risky." });
  });
});

describe("resolveInteractionPresentation — when a control re-arms", () => {
  it("keeps a completed action disabled while the document is still at the revision it acted on", () => {
    expect(
      resolve({
        durable: summary({ status: "completed", tabRevision: 4 }),
        surfaceRevision: 4,
        mode: "action",
      }).locked
    ).toBe(true);
  });

  it("re-arms a completed action once the agent moves the document forward, keeping the outcome", () => {
    const result = resolve({
      durable: summary({
        status: "completed",
        tabRevision: 4,
        outcomeMessage: "Deployed.",
      }),
      surfaceRevision: 5,
      mode: "action",
    });
    expect(result.locked).toBe(false);
    expect(result.caption).toMatchObject({
      status: "completed",
      message: "Deployed.",
    });
  });

  it.each(["rejected", "cancelled", "orphaned"] as const)(
    "re-arms an action immediately after %s, at the very same revision",
    (status) => {
      expect(
        resolve({
          durable: summary({ status, tabRevision: 4 }),
          surfaceRevision: 4,
          mode: "action",
        }).locked
      ).toBe(false);
    }
  );

  it("locks a completed once-form permanently — the server's partial unique index still covers completed", () => {
    expect(
      resolve({
        durable: summary({
          status: "completed",
          tabRevision: 1,
          outcomeMessage: "Filed.",
        }),
        surfaceRevision: 99,
        mode: "form-once",
      })
    ).toEqual({
      busy: false,
      locked: true,
      caption: {
        kind: "outcome",
        status: "completed",
        label: "Completed",
        tone: "success",
        message: "Filed.",
      },
    });
  });

  it.each(["rejected", "cancelled", "orphaned"] as const)(
    "re-arms a once-form after %s, which falls outside the server's unique index",
    (status) => {
      const result = resolve({
        durable: summary({
          status,
          outcomeMessage: "Try again with more detail.",
        }),
        mode: "form-once",
      });
      expect(result.locked).toBe(false);
      expect(result.caption).toMatchObject({
        message: "Try again with more detail.",
      });
    }
  );

  it("re-arms a repeatable form after completion without dropping the outcome", () => {
    const result = resolve({
      durable: summary({ status: "completed", outcomeMessage: "Logged." }),
      mode: "form-repeatable",
    });
    expect(result.locked).toBe(false);
    expect(result.caption).toMatchObject({
      status: "completed",
      message: "Logged.",
    });
  });
});

describe("resolveInteractionPresentation — local vs durable freshness", () => {
  it("keeps a just-submitted control locked before the refetch has caught up", () => {
    const result = resolve({
      local: { status: "queued", interactionId: "ix_new" },
      durable: undefined,
    });
    expect(result.locked).toBe(true);
    expect(result.caption).toMatchObject({ kind: "pending", status: "queued" });
  });

  it("lets the durable record win once it describes the same interaction", () => {
    const result = resolve({
      local: { status: "queued", interactionId: "ix_1" },
      durable: summary({
        id: "ix_1",
        status: "rejected",
        outcomeMessage: "Denied.",
      }),
    });
    expect(result.locked).toBe(false);
    expect(result.caption).toMatchObject({
      status: "rejected",
      message: "Denied.",
    });
  });

  it("does not let a stale terminal summary re-arm a control that was just resubmitted", () => {
    // The user retried after a rejection; the payload still shows the old
    // rejected record. Ids differ, so the newer local submission wins and the
    // button stays locked instead of inviting a duplicate submission.
    const result = resolve({
      local: { status: "notified", interactionId: "ix_2" },
      durable: summary({ id: "ix_1", status: "rejected" }),
      mode: "form-repeatable",
    });
    expect(result.locked).toBe(true);
    expect(result.caption).toMatchObject({
      kind: "pending",
      status: "notified",
    });
  });

  it("re-arms after a local error so the user can retry, when nothing durable contradicts it", () => {
    const result = resolve({
      local: { status: "error", message: "send failed" },
    });
    expect(result.locked).toBe(false);
    expect(result.caption).toEqual({ kind: "error", message: "send failed" });
  });

  it("does not offer a retry on a frozen surface even after a failed POST", () => {
    expect(
      resolve({
        local: { status: "error", message: "send failed" },
        readOnly: true,
      }).locked
    ).toBe(true);
  });
});

describe("indexInteractions", () => {
  it("looks a summary up by its (blockId, actionId) pair", () => {
    const index = indexInteractions([
      summary({ id: "a", blockId: "b1", actionId: "go" }),
      summary({ id: "b", blockId: "b1", actionId: "stop" }),
      summary({ id: "c", blockId: "b2", actionId: "go" }),
    ]);
    expect(findInteraction(index, "b1", "go")?.id).toBe("a");
    expect(findInteraction(index, "b1", "stop")?.id).toBe("b");
    expect(findInteraction(index, "b2", "go")?.id).toBe("c");
    expect(findInteraction(index, "b2", "stop")).toBeUndefined();
  });

  it("does not confuse pairs whose ids concatenate to the same string", () => {
    const index = indexInteractions([
      summary({ id: "a", blockId: "a b", actionId: "c" }),
      summary({ id: "b", blockId: "a", actionId: "b c" }),
    ]);
    expect(findInteraction(index, "a b", "c")?.id).toBe("a");
    expect(findInteraction(index, "a", "b c")?.id).toBe("b");
  });

  it("keeps identical actions on different items independent", () => {
    const index = indexInteractions([
      summary({
        id: "first",
        blockId: "b1",
        actionId: "approve",
        itemId: "item-a",
      }),
      summary({
        id: "second",
        blockId: "b1",
        actionId: "approve",
        itemId: "item-b",
      }),
    ]);
    expect(findInteraction(index, "b1", "approve", "item-a")?.id).toBe("first");
    expect(findInteraction(index, "b1", "approve", "item-b")?.id).toBe(
      "second"
    );
  });

  it("tolerates a payload with no interactions at all", () => {
    expect(
      findInteraction(indexInteractions(undefined), "b", "a")
    ).toBeUndefined();
    expect(findInteraction(indexInteractions([]), "b", "a")).toBeUndefined();
  });
});
