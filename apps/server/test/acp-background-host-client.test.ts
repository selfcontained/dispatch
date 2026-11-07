import { afterEach, expect, it, vi } from "vitest";
import { HostClient } from "../src/agents/acp/host-client.js";
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
  Reflect.set(client, "lastWelcome", {
    sessionId: "s",
    running: true,
    backgroundWorkSupported: supported,
  });
  vi.spyOn(client, "isConnected").mockReturnValue(true);
  const send = vi.fn();
  Reflect.set(client, "send", send);
  const handle = (value: unknown) =>
    Reflect.get(client, "handle").call(client, value);
  return { client, send, handle };
}
afterEach(() => vi.useRealTimers());
it("does not ask older hosts to serve an unsupported snapshot", async () => {
  const { client, send } = fixture(false);
  expect(await client.getBackgroundWork()).toEqual({
    status: "unsupported",
    items: [],
  });
  expect(send).not.toHaveBeenCalled();
});
it("uses the current session and rejects a response after replacement", async () => {
  const { client, send, handle } = fixture();
  const promise = client.getBackgroundWork();
  expect(send.mock.calls[0][0]).toMatchObject({
    type: "background_work",
    sessionId: "s",
  });
  Reflect.set(client, "lastWelcome", { sessionId: "replacement" });
  handle({
    type: "background_work_result",
    id: send.mock.calls[0][0].id,
    result: { status: "supported", items: [] },
  });
  expect(await promise).toEqual({ status: "unavailable", items: [] });
});
it("settles on disconnect or timeout without retaining prior reports", async () => {
  const first = fixture();
  const disconnected = first.client.getBackgroundWork();
  first.client.close();
  expect(await disconnected).toEqual({ status: "offline", items: [] });
  vi.useFakeTimers();
  const second = fixture();
  const timedOut = second.client.getBackgroundWork();
  await vi.advanceTimersByTimeAsync(2001);
  expect(await timedOut).toEqual({ status: "unavailable", items: [] });
});
