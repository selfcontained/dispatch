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

// Address discovery uses only active socket bindings and trusted configuration.
import {
  discoverSlackLinkOrigins,
  isAllowedSlackLinkOrigin,
} from "../src/notifications/slack-link-origins.js";
import type os from "node:os";
const fakeInterfaces =
  (...addresses: string[]) =>
  () => ({
    test: addresses.map(
      (address) =>
        ({
          address,
          family: address.includes(":") ? "IPv6" : "IPv4",
          internal: address === "127.0.0.1" || address === "::1",
          netmask: "",
          mac: "",
          cidr: null,
          scopeid: 0,
        }) as os.NetworkInterfaceInfo
    ),
  });
it("offers only explicit active binds with correct TLS and port", async () => {
  const origins = await discoverSlackLinkOrigins(
    {
      addresses: [
        { address: "127.0.0.1", port: 7443 },
        { address: "100.64.0.2", port: 7443 },
      ],
      tls: true,
    },
    { interfaces: fakeInterfaces("192.168.1.2") }
  );
  expect(origins.options.map((x) => x.url)).toEqual([
    "https://100.64.0.2:7443",
    "https://127.0.0.1:7443",
  ]);
  expect(origins.defaultUrl).toBe("https://100.64.0.2:7443");
  for (const value of [
    "http://100.64.0.2:7443",
    "https://100.64.0.2:443",
    "https://evil.test:7443",
    "https://100.64.0.2:7443/path",
    "https://u:p@100.64.0.2:7443",
    "https://100.64.0.2:7443/#x",
  ])
    expect(isAllowedSlackLinkOrigin(value, origins)).toBe(false);
  expect(isAllowedSlackLinkOrigin("https://100.64.0.2:7443/", origins)).toBe(
    true
  );
});
it("expands wildcard binds conservatively and prefers non-loopback without claiming reachability", async () => {
  const origins = await discoverSlackLinkOrigins(
    { addresses: [{ address: "0.0.0.0", port: 6767 }], tls: false },
    { interfaces: fakeInterfaces("127.0.0.1", "192.168.1.2", "2001:db8::2") }
  );
  expect(origins.defaultUrl).toBe("http://192.168.1.2:6767");
  expect(origins.options.map((x) => x.url)).toEqual([
    "http://192.168.1.2:6767",
    "http://127.0.0.1:6767",
  ]);
  const v6 = await discoverSlackLinkOrigins(
    { addresses: [{ address: "::", port: 6767 }], tls: false },
    {
      interfaces: fakeInterfaces(
        "192.168.1.2",
        "::1",
        "2001:db8::2",
        "fe80::1%en0",
        "ff02::1"
      ),
    }
  );
  expect(v6.options.map((x) => x.url)).toEqual([
    "http://[2001:db8::2]:6767",
    "http://[::1]:6767",
  ]);
});
it("offers configured DNS only when it resolves to an active bind, with an IP fallback", async () => {
  const input = {
    addresses: [{ address: "192.168.1.2", port: 6767 }],
    tls: false,
    configuredHost: "dispatch.example",
  };
  const resolved = await discoverSlackLinkOrigins(input, {
    resolve: async () => ["192.168.1.2"],
  });
  expect(resolved.options.map((x) => x.url)).toContain(
    "http://dispatch.example:6767"
  );
  const unrelated = await discoverSlackLinkOrigins(input, {
    resolve: async () => ["192.168.1.99"],
  });
  expect(unrelated.options.map((x) => x.url)).toEqual([
    "http://192.168.1.2:6767",
  ]);
  const failed = await discoverSlackLinkOrigins(input, {
    resolve: async () => {
      throw Error("DNS unavailable");
    },
  });
  expect(failed.defaultUrl).toBe("http://192.168.1.2:6767");
  expect(await discoverSlackLinkOrigins({ addresses: [], tls: false })).toEqual(
    { options: [], defaultUrl: null }
  );
});
