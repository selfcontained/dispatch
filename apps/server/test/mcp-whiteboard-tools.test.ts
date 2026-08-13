import { describe, expect, it, vi } from "vitest";

import { registerWhiteboardTools } from "../src/shared/mcp/whiteboard-tools.js";

type RegisteredTool = {
  name: string;
  config: { description?: string };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ text: string }>;
    isError?: true;
  }>;
};

function createMockServer() {
  const tools: RegisteredTool[] = [];
  return {
    registerTool: vi.fn(
      (
        name: string,
        config: RegisteredTool["config"],
        handler: RegisteredTool["handler"]
      ) => {
        tools.push({ name, config, handler });
      }
    ),
    tools,
  };
}

const ALL = new Set([
  "whiteboard_get",
  "whiteboard_update",
  "whiteboard_howto",
  "whiteboard_clear",
]);

function register(server: ReturnType<typeof createMockServer>, ctx = {}) {
  registerWhiteboardTools(server as never, ALL, {
    agentId: "agt_wb",
    getWhiteboard: vi.fn(),
    updateWhiteboard: vi.fn(),
    clearWhiteboard: vi.fn(),
    ...ctx,
  } as never);
}

describe("whiteboard tool guidance", () => {
  it("keeps the element reference out of whiteboard_update's description", () => {
    const server = createMockServer();
    register(server);

    const update = server.tools.find((t) => t.name === "whiteboard_update")!;
    // The description used to carry a ~6KB Excalidraw reference, which every
    // agent paid for in tools/list whether or not it ever drew anything.
    expect(update.config.description!.length).toBeLessThan(500);
    expect(update.config.description).toContain("whiteboard_howto");
    expect(update.config.description).not.toContain("Element Format Reference");
  });

  it("serves that reference from whiteboard_howto instead", async () => {
    const server = createMockServer();
    register(server);

    const howto = server.tools.find((t) => t.name === "whiteboard_howto")!;
    const result = await howto.handler({});
    const text = result.content[0]!.text;

    expect(text).toContain("Excalidraw Element Format Reference");
    expect(text).toContain("**Workflow:**");
    expect(text).toContain("**Arrows:**");
    expect(text.length).toBeGreaterThan(5000);
  });

  it("points a failed update at the howto", async () => {
    const server = createMockServer();
    register(server, {
      updateWhiteboard: vi.fn(async () => {
        throw new Error("element 'box-1' is missing type");
      }),
    });

    const update = server.tools.find((t) => t.name === "whiteboard_update")!;
    const result = await update.handler({ elements: [{ id: "box-1" }] });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("missing type");
    expect(result.content[0]!.text).toContain("whiteboard_howto");
  });
});
