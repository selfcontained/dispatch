import { describe, expect, it, vi } from "vitest";

import { simplifyElements } from "../src/shared/whiteboard.js";
import { isValidScene, MAX_ELEMENTS } from "../src/shared/whiteboard-store.js";

// ── mergeElements is not exported, so we test it indirectly through
// createWhiteboardHandlers. Import the module and extract the merge
// logic by testing the handlers with mocked deps. ──

import { createWhiteboardHandlers } from "../src/server/mcp-whiteboard-handlers.js";

function rect(id: string, x = 0, y = 0) {
  return { id, type: "rectangle", x, y, width: 100, height: 50 };
}

function text(id: string, t: string) {
  return {
    id,
    type: "text",
    x: 0,
    y: 0,
    width: 80,
    height: 20,
    text: t,
    originalText: t,
  };
}

function arrow(id: string, from: string, to: string) {
  return {
    id,
    type: "arrow",
    x: 100,
    y: 50,
    width: 100,
    height: 0,
    points: [
      [0, 0],
      [100, 0],
    ],
    startBinding: { elementId: from, focus: 0, gap: 1 },
    endBinding: { elementId: to, focus: 0, gap: 1 },
  };
}

// ── simplifyElements ──

describe("simplifyElements", () => {
  it("converts raw elements to simplified format", () => {
    const result = simplifyElements([
      rect("box1", 10, 20),
      text("label1", "Hello"),
    ]);
    expect(result).toEqual([
      { id: "box1", type: "rectangle", x: 10, y: 20, width: 100, height: 50 },
      {
        id: "label1",
        type: "text",
        x: 0,
        y: 0,
        width: 80,
        height: 20,
        text: "Hello",
      },
    ]);
  });

  it("skips deleted elements", () => {
    const result = simplifyElements([
      { ...rect("a"), isDeleted: true },
      rect("b"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });

  it("skips non-object values", () => {
    const result = simplifyElements([
      null,
      undefined,
      42,
      "str",
      rect("ok"),
    ] as unknown[]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ok");
  });

  it("extracts arrow bindings as from/to", () => {
    const result = simplifyElements([arrow("a1", "box1", "box2")]);
    expect(result[0].from).toBe("box1");
    expect(result[0].to).toBe("box2");
  });

  it("extracts containerId for bound text", () => {
    const el = { ...text("lbl", "Hi"), containerId: "box1" };
    const result = simplifyElements([el]);
    expect(result[0].containerId).toBe("box1");
  });

  it("extracts frameId", () => {
    const el = { ...rect("child"), frameId: "frame1" };
    const result = simplifyElements([el]);
    expect(result[0].frameId).toBe("frame1");
  });

  it("rounds angle and includes when non-zero", () => {
    const el = { ...rect("rotated"), angle: 1.5708 };
    const result = simplifyElements([el]);
    expect(result[0].angle).toBe(1.57);
  });

  it("omits angle when near zero", () => {
    const el = { ...rect("flat"), angle: 0.005 };
    const result = simplifyElements([el]);
    expect(result[0].angle).toBeUndefined();
  });

  it("extracts colors (skips transparent bg)", () => {
    const el = {
      ...rect("colored"),
      strokeColor: "#e03131",
      backgroundColor: "transparent",
    };
    const result = simplifyElements([el]);
    expect(result[0].strokeColor).toBe("#e03131");
    expect(result[0].backgroundColor).toBeUndefined();
  });

  it("includes non-transparent backgroundColor", () => {
    const el = { ...rect("filled"), backgroundColor: "#a5d8ff" };
    const result = simplifyElements([el]);
    expect(result[0].backgroundColor).toBe("#a5d8ff");
  });
});

// ── isValidScene ──

describe("isValidScene", () => {
  it("accepts valid scene", () => {
    expect(isValidScene({ elements: [rect("a")] })).toBe(true);
  });

  it("accepts empty scene", () => {
    expect(isValidScene({ elements: [] })).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidScene(null)).toBe(false);
  });

  it("rejects non-object", () => {
    expect(isValidScene("string")).toBe(false);
  });

  it("rejects missing elements", () => {
    expect(isValidScene({ foo: "bar" })).toBe(false);
  });

  it("rejects non-array elements", () => {
    expect(isValidScene({ elements: "not-array" })).toBe(false);
  });

  it("rejects oversized elements array", () => {
    const elements = Array.from({ length: MAX_ELEMENTS + 1 }, (_, i) =>
      rect(`e${i}`)
    );
    expect(isValidScene({ elements })).toBe(false);
  });

  it("accepts exactly MAX_ELEMENTS", () => {
    const elements = Array.from({ length: MAX_ELEMENTS }, (_, i) =>
      rect(`e${i}`)
    );
    expect(isValidScene({ elements })).toBe(true);
  });
});

// ── createWhiteboardHandlers (mergeElements + handler logic) ──

describe("createWhiteboardHandlers", () => {
  function createMockDeps() {
    const publishedEvents: unknown[] = [];
    return {
      pool: {
        query: vi.fn(),
      } as unknown as import("pg").Pool,
      mediaRoot: "/tmp/test-media",
      agentManager: {
        getAgent: vi.fn().mockResolvedValue({ id: "agt_test", mediaDir: null }),
      } as unknown as import("../src/agents/manager.js").AgentManager,
      publishUiEvent: vi.fn((e: unknown) => publishedEvents.push(e)),
      publishedEvents,
    };
  }

  function mockLoadReturn(
    pool: { query: ReturnType<typeof vi.fn> },
    scene: { elements: unknown[] },
    version = 1
  ) {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          scene,
          version: String(version),
          updated_by: "agent",
          updated_at: new Date(),
        },
      ],
    });
  }

  function mockSaveReturn(
    pool: { query: ReturnType<typeof vi.fn> },
    version: number
  ) {
    pool.query.mockResolvedValueOnce({
      rows: [{ version: String(version) }],
    });
  }

  function mockEmptyLoad(pool: { query: ReturnType<typeof vi.fn> }) {
    pool.query.mockResolvedValueOnce({ rows: [] });
  }

  describe("updateWhiteboard", () => {
    it("adds new elements to an empty board", async () => {
      const deps = createMockDeps();
      const handlers = createWhiteboardHandlers(deps);

      mockEmptyLoad(
        deps.pool as unknown as { query: ReturnType<typeof vi.fn> }
      );
      mockSaveReturn(
        deps.pool as unknown as { query: ReturnType<typeof vi.fn> },
        1
      );

      const result = await handlers.updateWhiteboard(
        "agt_test",
        [rect("a"), rect("b")],
        []
      );
      expect(result.addedIds).toEqual(["a", "b"]);
      expect(result.updatedIds).toEqual([]);
      expect(result.elementCount).toBe(2);
      expect(result.version).toBe(1);
    });

    it("upserts existing elements", async () => {
      const deps = createMockDeps();
      const handlers = createWhiteboardHandlers(deps);
      const pool = deps.pool as unknown as { query: ReturnType<typeof vi.fn> };

      mockLoadReturn(pool, { elements: [rect("a", 0, 0)] }, 1);
      mockSaveReturn(pool, 2);

      const result = await handlers.updateWhiteboard(
        "agt_test",
        [rect("a", 50, 50), rect("b")],
        []
      );
      expect(result.addedIds).toEqual(["b"]);
      expect(result.updatedIds).toEqual(["a"]);
      expect(result.elementCount).toBe(2);
    });

    it("deletes specified elements", async () => {
      const deps = createMockDeps();
      const handlers = createWhiteboardHandlers(deps);
      const pool = deps.pool as unknown as { query: ReturnType<typeof vi.fn> };

      mockLoadReturn(pool, { elements: [rect("a"), rect("b"), rect("c")] }, 1);
      mockSaveReturn(pool, 2);

      const result = await handlers.updateWhiteboard(
        "agt_test",
        [],
        ["a", "c"]
      );
      expect(result.deletedIds).toEqual(["a", "c"]);
      expect(result.elementCount).toBe(1);
    });

    it("publishes whiteboard.changed event", async () => {
      const deps = createMockDeps();
      const handlers = createWhiteboardHandlers(deps);
      const pool = deps.pool as unknown as { query: ReturnType<typeof vi.fn> };

      mockEmptyLoad(pool);
      mockSaveReturn(pool, 1);

      await handlers.updateWhiteboard("agt_test", [rect("a")], []);
      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "whiteboard.changed",
        agentId: "agt_test",
        version: 1,
        source: "agent",
      });
    });

    it("retries on optimistic lock conflict", async () => {
      const deps = createMockDeps();
      const handlers = createWhiteboardHandlers(deps);
      const pool = deps.pool as unknown as { query: ReturnType<typeof vi.fn> };

      // First attempt: load version 1, save fails (conflict)
      mockLoadReturn(pool, { elements: [] }, 1);
      pool.query.mockResolvedValueOnce({ rows: [] }); // save fails

      // Second attempt: load version 2, save succeeds
      mockLoadReturn(pool, { elements: [] }, 2);
      mockSaveReturn(pool, 3);

      const result = await handlers.updateWhiteboard(
        "agt_test",
        [rect("a")],
        []
      );
      expect(result.version).toBe(3);
    });

    it("throws after 3 failed attempts", async () => {
      const deps = createMockDeps();
      const handlers = createWhiteboardHandlers(deps);
      const pool = deps.pool as unknown as { query: ReturnType<typeof vi.fn> };

      for (let i = 0; i < 3; i++) {
        mockLoadReturn(pool, { elements: [] }, i + 1);
        pool.query.mockResolvedValueOnce({ rows: [] }); // save fails
      }

      await expect(
        handlers.updateWhiteboard("agt_test", [rect("a")], [])
      ).rejects.toThrow("concurrently");
    });

    it("throws for unknown agent", async () => {
      const deps = createMockDeps();
      (
        deps.agentManager.getAgent as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce(null);
      const handlers = createWhiteboardHandlers(deps);

      await expect(
        handlers.updateWhiteboard("agt_missing", [rect("a")], [])
      ).rejects.toThrow("Agent not found");
    });

    it("throws when merged result exceeds MAX_ELEMENTS", async () => {
      const deps = createMockDeps();
      const handlers = createWhiteboardHandlers(deps);
      const pool = deps.pool as unknown as { query: ReturnType<typeof vi.fn> };

      const hugeScene = {
        elements: Array.from({ length: MAX_ELEMENTS }, (_, i) => rect(`e${i}`)),
      };
      mockLoadReturn(pool, hugeScene, 1);

      await expect(
        handlers.updateWhiteboard("agt_test", [rect("new-one")], [])
      ).rejects.toThrow("full");
    });

    it("ignores incoming elements without required fields", async () => {
      const deps = createMockDeps();
      const handlers = createWhiteboardHandlers(deps);
      const pool = deps.pool as unknown as { query: ReturnType<typeof vi.fn> };

      mockEmptyLoad(pool);
      mockSaveReturn(pool, 1);

      const result = await handlers.updateWhiteboard(
        "agt_test",
        [
          { id: "valid", type: "rectangle", x: 0, y: 0 },
          { type: "rectangle" }, // missing id
          { id: "no-type" }, // missing type
          null as unknown as Record<string, unknown>,
        ],
        []
      );
      expect(result.addedIds).toEqual(["valid"]);
      expect(result.elementCount).toBe(1);
    });
  });

  describe("clearWhiteboard", () => {
    it("clears board and publishes event", async () => {
      const deps = createMockDeps();
      const handlers = createWhiteboardHandlers(deps);
      const pool = deps.pool as unknown as { query: ReturnType<typeof vi.fn> };

      mockLoadReturn(pool, { elements: [rect("a")] }, 1);
      mockSaveReturn(pool, 2);

      await handlers.clearWhiteboard("agt_test");
      expect(deps.publishUiEvent).toHaveBeenCalledWith({
        type: "whiteboard.changed",
        agentId: "agt_test",
        version: 2,
        source: "agent",
      });
    });

    it("throws for unknown agent", async () => {
      const deps = createMockDeps();
      (
        deps.agentManager.getAgent as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce(null);
      const handlers = createWhiteboardHandlers(deps);

      await expect(handlers.clearWhiteboard("agt_missing")).rejects.toThrow(
        "Agent not found"
      );
    });
  });

  describe("getWhiteboard", () => {
    it("returns empty state for nonexistent whiteboard", async () => {
      const deps = createMockDeps();
      const handlers = createWhiteboardHandlers(deps);
      const pool = deps.pool as unknown as { query: ReturnType<typeof vi.fn> };

      mockEmptyLoad(pool);

      const result = await handlers.getWhiteboard("agt_test");
      expect(result.elements).toEqual([]);
      expect(result.version).toBe(0);
      expect(result.updatedAt).toBeNull();
    });

    it("returns simplified elements for existing board", async () => {
      const deps = createMockDeps();
      const handlers = createWhiteboardHandlers(deps);
      const pool = deps.pool as unknown as { query: ReturnType<typeof vi.fn> };

      const now = new Date();
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            scene: { elements: [rect("a", 10, 20)] },
            version: "3",
            updated_by: "agent",
            updated_at: now,
          },
        ],
      });

      const result = await handlers.getWhiteboard("agt_test");
      expect(result.elements).toEqual([
        { id: "a", type: "rectangle", x: 10, y: 20, width: 100, height: 50 },
      ]);
      expect(result.version).toBe(3);
      expect(result.updatedAt).toBe(now.toISOString());
    });
  });
});
