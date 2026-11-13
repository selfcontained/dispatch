import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SlackApp,
  SlackDeliveryUnknownError,
  SlackRetryError,
} from "../src/notifications/slack-app.js";
import type { Pool } from "pg";

function fixture(socketUrlAppId = "A1") {
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
              url: `wss://wss.slack.com/link?app_id=${socketUrlAppId}&ticket=secret`,
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
  const app = new SlackApp(pool, transport as typeof fetch, () => {
    queueMicrotask(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: "hello",
          connection_info: { app_id: "A1" },
          num_connections: 1,
        }),
      } as MessageEvent)
    );
    return socket;
  });
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
    await f.app.addReaction("1.3", "white_check_mark");
    const bodies = f.transport.mock.calls
      .filter(([url]) =>
        /(chat\.(postMessage|update|postEphemeral)|reactions\.add)$/.test(url)
      )
      .map(([, init]) => JSON.parse(init!.body as string));
    expect(bodies.map((b) => b.channel)).toEqual(["C1", "C1", "C1", "C1"]);
    expect(bodies[2]).toMatchObject({ user: "U1", thread_ts: "1.2" });
    expect(bodies[3]).toEqual({
      channel: "C1",
      timestamp: "1.3",
      name: "white_check_mark",
    });
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
      note: "Images weren't attached: Slack refused them (invalid_blocks).",
    });
    expect(posts).toHaveLength(2);
    expect(posts[0].blocks.some((b: any) => b.type === "image")).toBe(true);
    expect(posts[1].blocks.some((b: any) => b.type === "image")).toBe(false);
  });
  it("waits out Slack's processing window for a just-uploaded image instead of dropping it", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir("/tmp/dogfood-slack-cdc9-test", { recursive: true });
    const png = "/tmp/dogfood-slack-cdc9-test/fresh-shot.png";
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
        // Slack's answer while a fresh private upload is still processing.
        // Slack names the file in `errors` or in response_metadata.messages.
        return posts.length === 1
          ? Response.json({
              ok: false,
              error: "invalid_blocks",
              response_metadata: {
                messages: [
                  "[ERROR] invalid slack file [json-pointer:/blocks/2/slack_file]",
                ],
              },
            })
          : posts.length === 2
            ? Response.json({
                ok: false,
                error: "invalid_blocks",
                errors: [
                  "invalid slack file [json-pointer:/blocks/2/slack_file]",
                ],
              })
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
    expect(result).toEqual({ sent: true });
    expect(posts).toHaveLength(3);
    for (const post of posts)
      expect(post.blocks.filter((b: any) => b.type === "image")).toEqual([
        { type: "image", slack_file: { id: "F9" }, alt_text: "fresh-shot.png" },
      ]);
  });
  it("shows the agent as the sender, keeping the name line only where Slack won't allow it", async () => {
    const send = async (scopes: string) => {
      const f = fixture();
      const real = f.transport.getMockImplementation()!;
      f.transport.mockImplementation(async (url, init) =>
        url.endsWith("auth.test")
          ? Response.json(
              { ok: true, team_id: "T1", team: "Local team", user_id: "UBOT" },
              { headers: { "x-oauth-scopes": scopes } }
            )
          : real(url, init)
      );
      await f.app.validate(credentials);
      await f.app.enable("C1", "http://lan");
      await f.app.postBlocks({
        text: "t",
        blocks: [
          {
            type: "section",
            block_id: "dispatch_who",
            text: { type: "mrkdwn", text: "*_builder-7_*" },
          },
          { type: "markdown", text: "hi" },
        ],
        username: "builder-7",
      });
      const body = JSON.parse(
        String(
          f.transport.mock.calls
            .filter(([u]) => u.endsWith("chat.postMessage"))
            .at(-1)![1]!.body
        )
      );
      f.app.stop();
      return body;
    };
    const named = await send("chat:write,chat:write.customize,files:write");
    expect(named.username).toBe("builder-7");
    expect(named.blocks.map((b: any) => b.type)).toEqual(["markdown"]);
    // An install without the scope would post as "Dispatch" with no name,
    // so it keeps the name line.
    const plain = await send("chat:write,files:write");
    expect(plain.username).toBeUndefined();
    expect(plain.blocks[0].block_id).toBe("dispatch_who");
  });
  it("downloads shared files only from Slack's host, and spots a missing files:read", async () => {
    const f = fixture();
    await f.app.validate(credentials);
    await f.app.enable("C1", "http://lan");
    const real = f.transport.getMockImplementation()!;
    const seen: string[] = [];
    let html = false;
    f.transport.mockImplementation(async (url, init) => {
      if (url.startsWith("https://files.slack.com/")) {
        seen.push(url);
        expect((init!.headers as any).Authorization).toMatch(/^Bearer /);
        return html
          ? new Response("<html>sign in</html>", {
              headers: { "content-type": "text/html" },
            })
          : new Response(new Uint8Array([1, 2, 3]), {
              headers: { "content-type": "image/png" },
            });
      }
      return real(url, init);
    });
    const ok = await f.app.downloadFile(
      "https://files.slack.com/files-pri/T1-F1/a.png",
      10
    );
    expect([...ok]).toEqual([1, 2, 3]);
    for (const bad of [
      "http://files.slack.com/files-pri/a.png",
      "https://evil.example/a.png",
      "https://files.slack.com.evil.example/a.png",
      "not a url",
    ])
      await expect(f.app.downloadFile(bad, 10)).rejects.toThrow(
        /unexpected file location/
      );
    // Over the cap while streaming, and refused up front when declared.
    await expect(
      f.app.downloadFile("https://files.slack.com/files-pri/T1-F1/a.png", 2)
    ).rejects.toThrow(/too large/);
    const declaredBig = f.transport.getMockImplementation()!;
    f.transport.mockImplementationOnce(
      async () =>
        new Response(new Uint8Array([1]), {
          headers: {
            "content-length": "999999999",
            "content-type": "image/png",
          },
        })
    );
    await expect(
      f.app.downloadFile("https://files.slack.com/files-pri/T1-F1/a.png", 10)
    ).rejects.toThrow(/too large/);
    f.transport.mockImplementation(declaredBig);
    html = true;
    await expect(
      f.app.downloadFile("https://files.slack.com/files-pri/T1-F1/a.png", 10)
    ).rejects.toThrow(/files:read/);
    // The token never went anywhere but files.slack.com.
    expect(seen.every((u) => u.startsWith("https://files.slack.com/"))).toBe(
      true
    );
    f.app.stop();
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
    data: JSON.stringify({ type: "hello", connection_info: { app_id: "A1" } }),
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

it("routes a Slack Socket Mode link-button envelope through the real identity handler", async () => {
  const { SlackAnswers } =
    await import("../src/notifications/slack-answers.js");
  const f = fixture();
  await f.app.validate(credentials);
  await f.app.enable("C1", "http://lan");
  const baseQuery = vi.mocked(f.pool.query).getMockImplementation()!;
  const identities: unknown[][] = [];
  vi.mocked(f.pool.query).mockImplementation((async (
    sql: string,
    values: any[]
  ) => {
    if (sql.startsWith("UPDATE slack_link_claims"))
      return { rowCount: 1, rows: [] };
    if (sql.startsWith("INSERT INTO slack_answerers")) {
      identities.push(values);
      return { rowCount: 1, rows: [] };
    }
    return (baseQuery as any)(sql, values);
  }) as any);
  const answers = new SlackAnswers(
    f.pool,
    f.app,
    () => null as never,
    async () => null
  );
  answers.start();
  try {
    f.socket.onmessage!({
      data: JSON.stringify({
        envelope_id: "link-envelope",
        type: "interactive",
        accepts_response_payload: false,
        payload: {
          type: "block_actions",
          api_app_id: "A1",
          team: { id: "T1", domain: "example" },
          user: { id: "U1", username: "member", team_id: "T1" },
          container: {
            type: "message",
            message_ts: "123.456",
            channel_id: "C1",
            is_ephemeral: false,
          },
          channel: { id: "C1", name: "dispatch" },
          actions: [
            {
              type: "button",
              action_id: "dispatch_link",
              block_id: "link",
              value: "fixture-only-nonce",
              action_ts: "124.567",
            },
          ],
        },
      }),
    } as MessageEvent);
    await vi.waitFor(() => expect(identities).toHaveLength(1));
    expect(identities[0]?.slice(2)).toEqual(["T1", "U1", "@member"]);
    expect(f.socket.send).toHaveBeenCalledWith(
      JSON.stringify({ envelope_id: "link-envelope" })
    );
  } finally {
    answers.stop();
    f.app.stop();
  }
});

it("rechecks stored grants concurrently without rebinding or sending messages, and clears unknown evidence", async () => {
  const f = fixture();
  await f.app.validate(credentials);
  await f.app.enable("C1", "http://lan");
  f.transport.mockResolvedValueOnce(
    Response.json(
      { ok: true, team_id: "T1" },
      { headers: { "x-oauth-scopes": "chat:write" } }
    )
  );
  await f.app.recheckPermissions();
  expect((await f.app.settings()).missingAnswerScopes).toEqual([
    "channels:history",
    "groups:history",
  ]);
  const before = [...f.settings];
  const count = f.transport.mock.calls.length;
  f.transport.mockResolvedValueOnce(
    Response.json(
      { ok: true, team_id: "T1" },
      {
        headers: {
          "x-oauth-scopes": "chat:write,channels:history,groups:history",
        },
      }
    )
  );
  const first = f.app.recheckPermissions();
  expect(f.app.recheckPermissions()).toBe(first);
  await first;
  expect(
    f.transport.mock.calls.slice(count).map(([url]) => url.split("/").at(-1))
  ).toEqual(["auth.test"]);
  expect([...f.settings]).toEqual(before);
  expect(await f.app.settings()).toMatchObject({
    missingAnswerScopes: [],
    missingLinkScopes: [],
    missingImageScopes: ["files:write"],
  });
  await f.app.recheckPermissions();
  expect(await f.app.settings()).toMatchObject({
    missingAnswerScopes: null,
    missingLinkScopes: null,
    missingImageScopes: null,
  });
  f.transport.mockResolvedValueOnce(
    Response.json({ ok: false, error: "invalid_auth" })
  );
  await expect(f.app.recheckPermissions()).rejects.toThrow(
    "credentials rejected"
  );
  expect([...f.settings]).toEqual(before);
  f.app.stop();
});

it("reports safe callback refusal and failure stages without retaining envelope secrets", async () => {
  const f = fixture();
  await f.app.validate(credentials);
  await f.app.enable("C1", "http://lan");
  f.app.setInboundHandler(async () => {
    throw new Error("secret-provider-payload");
  });
  const deliver = (appId: string) =>
    f.socket.onmessage!({
      data: JSON.stringify({
        type: "interactive",
        envelope_id: "diagnostic",
        payload: {
          api_app_id: appId,
          team: { id: "T1" },
          type: "block_actions",
          actions: [{ value: "secret-nonce" }],
        },
      }),
    } as MessageEvent);
  deliver("wrong");
  await vi.waitFor(async () =>
    expect((await f.app.settings()).callbackDiagnostic?.stage).toBe(
      "app_mismatch"
    )
  );
  deliver("A1");
  await vi.waitFor(async () =>
    expect((await f.app.settings()).callbackDiagnostic?.stage).toBe(
      "handler_failed"
    )
  );
  expect(JSON.stringify(await f.app.settings())).not.toMatch(
    /secret-provider|secret-nonce/
  );
  expect((await f.app.settings()).callbackStageCounts).toMatchObject({
    received: 2,
    app_mismatch: 1,
    accepted: 1,
    handler_failed: 1,
  });
  f.socket.onmessage!({
    data: JSON.stringify({
      type: "events_api",
      envelope_id: "background",
      payload: { api_app_id: "A1", team_id: "T1", event: { type: "message" } },
    }),
  } as MessageEvent);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect((await f.app.settings()).callbackDiagnostic?.stage).toBe(
    "handler_failed"
  );
  expect((await f.app.settings()).callbackStageCounts.received).toBe(2);
  f.app.stop();
});

it("uses authenticated hello identity when the connection URL app_id is opaque", async () => {
  const f = fixture("a".repeat(64));
  await f.app.validate(credentials);
  await f.app.enable("C1", "http://lan");
  f.socket.onmessage!({
    data: JSON.stringify({
      type: "hello",
      connection_info: { app_id: "A1" },
      num_connections: 1,
    }),
  } as MessageEvent);
  const handler = vi.fn(async () => {});
  f.app.setInboundHandler(handler);
  f.socket.onmessage!({
    data: JSON.stringify({
      type: "interactive",
      envelope_id: "opaque-url",
      payload: { type: "block_actions", api_app_id: "A1", team: { id: "T1" } },
    }),
  } as MessageEvent);
  await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  f.app.stop();
});

it("refuses callbacks when canonical socket identity changes", async () => {
  const f = fixture();
  await f.app.validate(credentials);
  await f.app.enable("C1", "http://lan");
  const handler = vi.fn(async () => {});
  f.app.setInboundHandler(handler);
  f.socket.onmessage!({
    data: JSON.stringify({
      type: "hello",
      connection_info: { app_id: "AOTHER" },
    }),
  } as MessageEvent);
  expect((await f.app.settings()).status).toBe("app_identity_mismatch");
  f.socket.onmessage!({
    data: JSON.stringify({
      type: "interactive",
      envelope_id: "changed-app",
      payload: { api_app_id: "A1", team: { id: "T1" }, type: "block_actions" },
    }),
  } as MessageEvent);
  await vi.waitFor(async () =>
    expect((await f.app.settings()).callbackDiagnostic?.stage).toBe(
      "identity_unverified"
    )
  );
  expect(handler).not.toHaveBeenCalled();
  f.app.stop();
});
