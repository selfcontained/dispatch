import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "../src/agents/acp/host-client.js";
import type { HostMessage } from "../src/agents/acp/host-protocol.js";

function fixture(supported = true) {
  const client = new HostClient({
    agentId: "a",
    socketPath: "/tmp/unused",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    fromSeq: () => 0,
    journalId: () => null,
    onEvent: vi.fn(),
    onWelcome: vi.fn(),
    onGone: vi.fn(),
  });
  const welcome = {
    type: "welcome",
    agentId: "a",
    sessionId: "s",
    running: true,
    ...(supported ? { mcpInventorySupported: true } : {}),
  };
  Reflect.set(client, "lastWelcome", welcome);
  vi.spyOn(client, "isConnected").mockReturnValue(true);
  const send = vi.fn();
  Reflect.set(client, "send", send);
  const handle = (message: unknown) =>
    Reflect.get(client, "handle").call(client, message as HostMessage);
  return { client, send, handle };
}
afterEach(() => vi.useRealTimers());
describe("MCP host client request lifecycle", () => {
  it("does not send to older hosts without the capability", async () => {
    const { client, send } = fixture(false);
    expect(await client.getMcpInventory("a")).toEqual({
      agentId: "a",
      status: "unsupported",
      inventory: null,
    });
    expect(send).not.toHaveBeenCalled();
  });
  it("times out and discards late replies", async () => {
    vi.useFakeTimers();
    const { client, send, handle } = fixture();
    const result = client.getMcpInventory("a");
    const { id, sessionId } = send.mock.calls[0][0];
    expect(sessionId).toBe("s");
    await vi.advanceTimersByTimeAsync(10001);
    expect((await result).status).toBe("timeout");
    handle({
      type: "mcp_inventory_result",
      id,
      result: {
        agentId: "a",
        status: "ok",
        inventory: { version: 1, servers: [] },
      },
    });
    expect(Reflect.get(client, "pendingInventory").size).toBe(0);
  });
  it("discards another agent's response and changed welcome identities", async () => {
    for (const changed of [false, true]) {
      const { client, send, handle } = fixture();
      const result = client.getMcpInventory("a");
      const { id } = send.mock.calls[0][0];
      if (changed)
        Reflect.set(client, "lastWelcome", { sessionId: "replacement" });
      handle({
        type: "mcp_inventory_result",
        id,
        result: {
          agentId: changed ? "a" : "wrong",
          status: "ok",
          inventory: { version: 1, servers: [] },
        },
      });
      expect((await result).status).toBe("unavailable");
    }
  });
  it("settles safely on host close or an error reply", async () => {
    const first = fixture();
    const closed = first.client.getMcpInventory("a");
    first.client.close();
    expect((await closed).status).toBe("offline");
    const second = fixture();
    const failed = second.client.getMcpInventory("a");
    second.handle({
      type: "error",
      id: second.send.mock.calls[0][0].id,
      message: "native secret",
    });
    expect(await failed).toEqual({
      agentId: "a",
      status: "offline",
      inventory: null,
    });
  });
});
