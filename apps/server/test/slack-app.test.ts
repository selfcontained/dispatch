import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SlackApp,
  SlackDeliveryUnknownError,
  SlackRetryError,
} from "../src/notifications/slack-app.js";
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
  it("routes only bound app/team envelopes to the handler and acks modal results within budget", async () => {
    const f = fixture();
    await f.app.validate(credentials);
    await f.app.enable("C1", "http://lan");
    const seen: unknown[] = [];
    f.app.setInboundHandler(async (inbound) => {
      seen.push(inbound.payload);
      if (inbound.payload.type === "view_submission")
        return { response_action: "errors", errors: { f0: "Required." } };
    });
    const deliver = (envelope: Record<string, unknown>) =>
      f.socket.onmessage!({ data: JSON.stringify(envelope) } as MessageEvent);
    const flush = () => new Promise((r) => setTimeout(r, 10));
    deliver({
      type: "interactive",
      envelope_id: "E1",
      payload: {
        api_app_id: "A1",
        team: { id: "forged" },
        type: "block_actions",
      },
    });
    deliver({
      type: "events_api",
      envelope_id: "E2",
      payload: { api_app_id: "A9", team_id: "T1", event: { type: "message" } },
    });
    deliver({
      type: "interactive",
      envelope_id: "E3",
      payload: {
        api_app_id: "A1",
        team: { id: "T1" },
        type: "view_submission",
      },
    });
    deliver({
      type: "events_api",
      envelope_id: "E4",
      payload: { api_app_id: "A1", team_id: "T1", event: { type: "message" } },
    });
    await flush();
    expect(seen).toHaveLength(2);
    const acks = (f.socket.send as ReturnType<typeof vi.fn>).mock.calls.map(
      ([raw]) => JSON.parse(raw as string)
    );
    expect(acks).toEqual(
      expect.arrayContaining([
        { envelope_id: "E1" },
        { envelope_id: "E2" },
        { envelope_id: "E4" },
        {
          envelope_id: "E3",
          payload: { response_action: "errors", errors: { f0: "Required." } },
        },
      ])
    );
    f.app.stop();
  });
  it("tells the person when a slow modal submission is refused after the ack", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.app.validate(credentials);
    await f.app.enable("C1", "http://lan");
    f.app.setInboundHandler(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                response_action: "errors",
                errors: {
                  f0: "Already answered — your input was not recorded.",
                },
              }),
            4000
          )
        )
    );
    f.socket.onmessage!({
      data: JSON.stringify({
        type: "interactive",
        envelope_id: "E6",
        payload: {
          api_app_id: "A1",
          team: { id: "T1" },
          type: "view_submission",
          user: { id: "U1" },
        },
      }),
    } as MessageEvent);
    await vi.advanceTimersByTimeAsync(2600);
    expect(f.socket.send).toHaveBeenCalledWith(
      JSON.stringify({ envelope_id: "E6" })
    );
    await vi.advanceTimersByTimeAsync(2000);
    const ephemeral = f.transport.mock.calls.find(([url]) =>
      url.endsWith("chat.postEphemeral")
    );
    expect(JSON.parse(ephemeral![1]!.body as string)).toMatchObject({
      user: "U1",
      text: "Not recorded: Already answered — your input was not recorded.",
    });
    f.app.stop();
  });
  it("acks a slow modal submission before Slack's 3 second deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.app.validate(credentials);
    await f.app.enable("C1", "http://lan");
    f.app.setInboundHandler(() => new Promise(() => {}));
    f.socket.onmessage!({
      data: JSON.stringify({
        type: "interactive",
        envelope_id: "E5",
        payload: {
          api_app_id: "A1",
          team: { id: "T1" },
          type: "view_submission",
        },
      }),
    } as MessageEvent);
    await vi.advanceTimersByTimeAsync(2600);
    expect(f.socket.send).toHaveBeenCalledWith(
      JSON.stringify({ envelope_id: "E5" })
    );
    f.app.stop();
  });
  it("posts Block Kit, updates and ephemerals only to the bound channel", async () => {
    const f = fixture();
    await f.app.validate(credentials);
    await f.app.enable("C1", "http://lan");
    await f.app.postBlocks({ text: "t", blocks: [{ type: "divider" }] });
    await f.app.updateMessage("1.2", "u", []);
    await f.app.postEphemeral("U1", "e", "1.2");
    const bodies = f.transport.mock.calls
      .filter(([url]) => /chat\.(postMessage|update|postEphemeral)$/.test(url))
      .map(([, init]) => JSON.parse(init!.body as string));
    expect(bodies.map((b) => b.channel)).toEqual(["C1", "C1", "C1"]);
    expect(bodies[2]).toMatchObject({ user: "U1", thread_ts: "1.2" });
    f.app.stop();
  });
  it("classifies post failures: only definite non-deliveries are retryable", async () => {
    const outcome = async (fail: () => Response | Promise<Response>) => {
      const f = fixture();
      await f.app.validate(credentials);
      await f.app.enable("C1", "http://lan");
      const real = f.transport.getMockImplementation()!;
      f.transport.mockImplementation(async (url, init) =>
        url.endsWith("chat.postMessage") ? fail() : real(url, init)
      );
      const error = await f.app.postBlocks({ text: "t", blocks: [] }).then(
        () => null,
        (e: unknown) => e
      );
      f.app.stop();
      return error;
    };
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const timeout = Object.assign(new Error("aborted"), {
      name: "TimeoutError",
    });
    // May have been posted: unknown, never resend.
    for (const status of [500, 502, 503, 504])
      expect(await outcome(() => new Response("x", { status }))).toBeInstanceOf(
        SlackDeliveryUnknownError
      );
    expect(
      await outcome(() => {
        throw timeout;
      })
    ).toBeInstanceOf(SlackDeliveryUnknownError);
    expect(
      await outcome(() => new Response("not json", { status: 200 }))
    ).toBeInstanceOf(SlackDeliveryUnknownError);
    // Definitely not posted: retryable.
    const definite = [
      await outcome(() => {
        throw refused;
      }),
      await outcome(() => new Response("x", { status: 400 })),
      await outcome(() =>
        Response.json({ ok: false, error: "channel_not_found" })
      ),
    ];
    for (const error of definite) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(SlackDeliveryUnknownError);
    }
    expect(
      await outcome(
        () =>
          new Response("x", { status: 429, headers: { "retry-after": "2" } })
      )
    ).toBeInstanceOf(SlackRetryError);
  });
  it("uploads images privately and only ever sends bytes to Slack's upload host", async () => {
    const upload = async (uploadUrl: string) => {
      const f = fixture();
      await f.app.validate(credentials);
      await f.app.enable("C1", "http://lan");
      const real = f.transport.getMockImplementation()!;
      f.transport.mockImplementation(async (url, init) =>
        url.endsWith("files.getUploadURLExternal")
          ? Response.json({ ok: true, upload_url: uploadUrl, file_id: "F42" })
          : url === uploadUrl
            ? new Response("OK", { status: 200 })
            : url.endsWith("files.completeUploadExternal")
              ? Response.json({ ok: true, files: [{ id: "F42" }] })
              : real(url, init)
      );
      const result = await f.app
        .uploadImage(new Uint8Array([1, 2, 3]), "shot.png")
        .then(
          (id) => id,
          (e: Error) => e
        );
      const calls = f.transport.mock.calls.map(([url, init]) => ({
        url: String(url),
        body: init?.body,
      }));
      f.app.stop();
      return { result, calls };
    };
    const ok = await upload("https://files.slack.com/upload/v1/abc");
    expect(ok.result).toBe("F42");
    const names = ok.calls.map((c) => c.url.split("/").at(-1));
    expect(names.slice(-3)).toEqual([
      "files.getUploadURLExternal",
      "abc",
      "files.completeUploadExternal",
    ]);
    // Form-encoded size request; no channel, so the file stays private.
    expect(String(ok.calls.at(-3)!.body)).toBe("filename=shot.png&length=3");
    expect(JSON.parse(String(ok.calls.at(-1)!.body))).toEqual({
      files: [{ id: "F42", title: "shot.png" }],
    });
    for (const evil of [
      "https://evil.example/upload",
      "http://files.slack.com/upload",
      "https://slack.com.evil.example/x",
    ]) {
      const bad = await upload(evil);
      expect(bad.result).toBeInstanceOf(Error);
      expect(bad.calls.some((c) => c.url === evil)).toBe(false);
    }
  });
  it("a message Slack rejects for its image is resent as words through the real 1 msg/s guard", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir("/tmp/dogfood-slack-cdc9-test", { recursive: true });
    const png = "/tmp/dogfood-slack-cdc9-test/app-shot.png";
    await writeFile(png, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const f = fixture();
    await f.app.validate(credentials);
    await f.app.enable("C1", "http://lan");
    const real = f.transport.getMockImplementation()!;
    const posts: any[] = [];
    f.transport.mockImplementation(async (url, init) => {
      if (url.endsWith("files.getUploadURLExternal"))
        return Response.json({
          ok: true,
          upload_url: "https://files.slack.com/upload/v1/x",
          file_id: "F9",
        });
      if (url === "https://files.slack.com/upload/v1/x")
        return new Response("OK");
      if (url.endsWith("files.completeUploadExternal"))
        return Response.json({ ok: true, files: [{ id: "F9" }] });
      if (url.endsWith("chat.postMessage")) {
        posts.push(JSON.parse(String(init!.body)));
        return posts.length === 1
          ? Response.json({ ok: false, error: "invalid_blocks" })
          : Response.json({ ok: true, ts: "2.2" });
      }
      return real(url, init);
    });
    const { SlackNotifier } = await import("../src/notifications/slack.js");
    const notifier = new SlackNotifier(
      null as never,
      {
        warn: () => {},
        info: () => {},
        debug: () => {},
        error: () => {},
      } as never
    );
    (notifier as any).app = f.app;
    const result = await notifier.sendNotification(
      { id: "agt_1", name: "builder-7" } as never,
      { message: "See chart", images: [png] }
    );
    f.app.stop();
    expect(result).toMatchObject({
      sent: true,
      note: expect.stringMatching(/couldn't show/),
    });
    expect(posts).toHaveLength(2);
    expect(posts[0].blocks.some((b: any) => b.type === "image")).toBe(true);
    expect(posts[1].blocks.some((b: any) => b.type === "image")).toBe(false);
  });
  it("reports missing thread-reply scopes from Slack's granted scope header", async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce(
      Response.json(
        { ok: true, team_id: "T1", team: "Local team", user_id: "UBOT" },
        {
          headers: { "x-oauth-scopes": "chat:write,channels:read,groups:read" },
        }
      )
    );
    await f.app.validate(credentials);
    expect((await f.app.settings()).missingAnswerScopes).toEqual([
      "channels:history",
      "groups:history",
      "files:write",
    ]);
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

it("prefers ordinary interfaces over virtual interfaces without removing options", async () => {
  const result = await discoverSlackLinkOrigins(
    { addresses: [{ address: "0.0.0.0", port: 6767 }], tls: false },
    {
      interfaces: () => ({
        utun4: fakeInterfaces("100.64.0.2")().test,
        en0: fakeInterfaces("192.168.1.2")().test,
        docker0: fakeInterfaces("172.17.0.1")().test,
      }),
    }
  );
  expect(result.defaultUrl).toBe("http://192.168.1.2:6767");
  expect(result.options).toEqual([
    { url: "http://192.168.1.2:6767", loopback: false },
    { url: "http://100.64.0.2:6767", loopback: false },
    { url: "http://172.17.0.1:6767", loopback: false },
    { url: "http://127.0.0.1:6767", loopback: true },
  ]);
  const virtualOnly = await discoverSlackLinkOrigins(
    { addresses: [{ address: "0.0.0.0", port: 6767 }], tls: false },
    { interfaces: () => ({ utun4: fakeInterfaces("100.64.0.2")().test }) }
  );
  expect(virtualOnly.defaultUrl).toBe("http://100.64.0.2:6767");
});
