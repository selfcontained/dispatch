import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackApp } from "../src/notifications/slack-app.js";
import type { Pool } from "pg";

function fixture() {
  const settings = new Map<string, string>();
  const pool = {
    query: vi.fn(async (sql: string, values: string[]) => {
      if (sql.startsWith("SELECT"))
        return {
          rows: settings.has(values[0]!)
            ? [{ value: settings.get(values[0]!) }]
            : [],
        };
      if (sql.startsWith("DELETE")) settings.delete(values[0]!);
      else settings.set(values[0]!, values[1]!);
      return { rows: [] };
    }),
  } as unknown as Pool;
  const transport = vi.fn(async (url: string, init?: RequestInit) => {
    const method = url.split("/").at(-1);
    const result =
      method === "auth.test"
        ? { ok: true, team_id: "T1", team: "Local team", bot_id: "B1" }
        : method === "apps.connections.open"
          ? {
              ok: true,
              url: "wss://wss.slack.com/link?app_id=A1&ticket=secret",
            }
          : method === "conversations.list"
            ? {
                ok: true,
                channels: [
                  { id: "C1", name: "dispatch", is_member: true },
                  { id: "C2", name: "not-joined", is_member: false },
                ],
              }
            : { ok: true, ts: "1.2" };
    return Response.json(result);
  });
  const socket = {
    close: vi.fn(),
    send: vi.fn(),
    onmessage: null,
    onclose: null,
    onerror: null,
  } as unknown as WebSocket;
  const app = new SlackApp(pool, transport as typeof fetch, () => socket);
  return { app, pool, settings, transport, socket };
}
const credentials = { botToken: "xoxb-fake", appToken: "xapp-fake" };
afterEach(() => vi.useRealTimers());
describe("Slack app boundary", () => {
  it("discovers workspace and joined channels, masks tokens, sends only to bound channel", async () => {
    const f = fixture();
    expect(await f.app.validate(credentials)).toEqual({
      teamName: "Local team",
      channels: [{ id: "C1", name: "dispatch", private: false }],
    });
    await expect(f.app.enable("C2", "http://lan:3000")).rejects.toThrow(
      "Choose a channel"
    );
    await f.app.enable("C1", "http://lan:3000");
    expect(JSON.stringify(await f.app.settings())).not.toMatch(
      /xoxb|xapp|ticket/
    );
    await f.app.send("Hello <!channel>");
    const call = f.transport.mock.calls.at(-1)!;
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({
      channel: "C1",
      mrkdwn: false,
      text: "Hello &lt;!channel&gt;",
      unfurl_links: false,
    });
    expect(call[1]!.redirect).toBe("error");
    f.app.stop();
  });
  it("acks envelopes without executing action payloads and reconnects after disconnect", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.app.validate(credentials);
    await f.app.enable("C1", "http://lan");
    f.socket.onmessage!({
      data: JSON.stringify({
        type: "interactive",
        envelope_id: "E1",
        payload: {
          team: { id: "forged" },
          actions: [{ action_id: "approve" }],
        },
      }),
    } as MessageEvent);
    expect(f.socket.send).toHaveBeenCalledWith(
      JSON.stringify({ envelope_id: "E1" })
    );
    expect(
      f.transport.mock.calls.filter(([url]) => url.endsWith("chat.postMessage"))
    ).toHaveLength(0);
    f.socket.onmessage!({
      data: JSON.stringify({ type: "disconnect" }),
    } as MessageEvent);
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      f.transport.mock.calls.filter(([url]) =>
        url.endsWith("apps.connections.open")
      )
    ).toHaveLength(3);
    await f.app.disconnect();
    expect(f.settings.size).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect((await f.app.settings()).status).toBe("disabled");
  });
  it("rejects redirects, malformed credentials and unvalidated enable", async () => {
    const f = fixture();
    await expect(
      f.app.validate({ ...credentials, appToken: "wrong" })
    ).rejects.toThrow("app token");
    await expect(f.app.enable("C1", "http://lan")).rejects.toThrow("Validate");
    f.transport.mockResolvedValueOnce(
      Response.json({
        ok: false,
        error: "invalid_auth",
        secret: "xoxb-sensitive",
      })
    );
    await expect(f.app.validate(credentials)).rejects.toThrow(
      "credentials rejected"
    );
    expect(JSON.stringify(await f.app.settings())).not.toContain("sensitive");
  });
  it("does not follow arbitrary socket URLs or redirect pending work after a binding change", async () => {
    const f = fixture();
    await f.app.validate(credentials);
    await f.app.enable("C1", "http://lan");
    await expect(f.app.send("old alert", "old-binding")).rejects.toThrow(
      "destination changed"
    );
    f.app.stop();
    f.transport
      .mockResolvedValueOnce(Response.json({ ok: true, team_id: "T1" }))
      .mockResolvedValueOnce(
        Response.json({ ok: true, url: "wss://attacker.test/token" })
      );
    await expect(f.app.validate(credentials)).rejects.toThrow(
      "socket endpoint"
    );
  });
});

it("candidate validation failure leaves a connected installation healthy", async () => {
  const f = fixture();
  await f.app.validate(credentials);
  await f.app.enable("C1", "http://lan");
  f.socket.onmessage!({
    data: JSON.stringify({ type: "hello" }),
  } as MessageEvent);
  f.transport.mockResolvedValueOnce(
    Response.json({ ok: false, error: "invalid_auth" })
  );
  await expect(f.app.validate(credentials)).rejects.toThrow(
    "credentials rejected"
  );
  expect((await f.app.settings()).status).toBe("connected");
  expect(f.settings.size).toBe(1);
  f.app.stop();
});
it("uses form paging and rejects a repeated cursor without unbounded requests", async () => {
  const f = fixture();
  await f.app.validate(credentials);
  const listCall = f.transport.mock.calls.find(([url]) =>
    url.endsWith("conversations.list")
  )!;
  expect(listCall[1]!.headers).toMatchObject({
    "Content-Type": "application/x-www-form-urlencoded",
  });
  expect(new URLSearchParams(listCall[1]!.body as string).get("types")).toBe(
    "public_channel,private_channel"
  );
  f.transport.mockImplementation(async () =>
    Response.json({
      ok: true,
      channels: [],
      response_metadata: { next_cursor: "repeat" },
    })
  );
  await expect(f.app.refreshChannels()).rejects.toThrow("pagination");
});
