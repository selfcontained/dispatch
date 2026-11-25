import {
  forgetLearnedAgentModels,
  setLearnedAgentModels,
  getAgentModelOptions,
} from "../src/shared/agent-models.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  remoteEngineTransport,
  runnerModelCatalogSource,
} from "../src/agents/remote/engine-transport.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";

const catalog = (id: string) => ({
  defaultModel: id,
  models: [{ id, label: id }],
});
const catalogReply = (id: string) => ({
  value: JSON.stringify({
    ok: true,
    capability: { type: "model_catalog", catalog: catalog(id) },
  }),
});

function setup(source?: "live" | "learned") {
  const requestRunner = vi.fn<RemoteRunnerService["requestRunner"]>();
  let notify: ((id: string) => void) | undefined;
  const log = { warn: vi.fn(), debug: vi.fn() };
  const transport = remoteEngineTransport(
    {
      requestRunner,
      onConnectionChange(listener: (id: string) => void) {
        notify = listener;
      },
    } as unknown as RemoteRunnerService,
    log,
    source
  );
  return {
    requestRunner,
    log,
    transport,
    read: runnerModelCatalogSource(transport),
    reconnect: (runnerId: string) => notify?.(runnerId),
  };
}

afterEach(() => {
  vi.useRealTimers();
  forgetLearnedAgentModels();
});

describe("runner model catalog cache", () => {
  it("learned mode reads each Dispatch catalog/default without any runner request", async () => {
    const { read, transport, requestRunner } = setup("learned");
    requestRunner.mockImplementation(async () => {
      throw new Error("Must not start discovery");
    });
    const effort = [
      { value: "high", name: "High", description: "Full engine description" },
    ];
    setLearnedAgentModels("codex", [{ id: "local", label: "Local" }], "local");
    setLearnedAgentModels(
      "codex",
      [{ id: "alpha", label: "Alpha", effort }],
      "alpha",
      "alpha"
    );
    setLearnedAgentModels(
      "codex",
      [{ id: "beta", label: "Beta" }],
      "beta",
      "beta"
    );
    await expect(read("alpha", "codex")).resolves.toEqual({
      defaultModel: "alpha",
      models: [{ id: "alpha", label: "Alpha", effort }],
    });
    await expect(read("beta", "codex")).resolves.toEqual({
      defaultModel: "beta",
      models: [{ id: "beta", label: "Beta" }],
    });
    expect(
      await transport.send("alpha", {
        type: "model_catalog",
        engine: "codex",
        model: "alpha",
      })
    ).toMatchObject({ capability: { catalog: { models: [{ effort }] } } });
    setLearnedAgentModels(
      "codex",
      [{ id: "new", label: "New" }],
      "new",
      "alpha"
    );
    await expect(read("alpha", "codex")).resolves.toEqual({
      defaultModel: "new",
      models: [{ id: "new", label: "New" }],
    });
    await expect(read("fresh", "claude")).resolves.toEqual({
      defaultModel: null,
      models: getAgentModelOptions("claude", "fresh"),
    });
    expect(requestRunner).not.toHaveBeenCalled();
  });

  it("coalesces concurrent reads and expires each runner and engine independently", async () => {
    vi.useFakeTimers();
    const { read, requestRunner } = setup();
    requestRunner.mockResolvedValueOnce(catalogReply("one"));
    const first = read("alpha", "claude");
    const concurrent = read("alpha", "claude");
    expect(requestRunner).toHaveBeenCalledTimes(1);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      catalog("one"),
      catalog("one"),
    ]);

    requestRunner
      .mockResolvedValueOnce(catalogReply("other-engine"))
      .mockResolvedValueOnce(catalogReply("other-runner"))
      .mockResolvedValueOnce(catalogReply("refreshed"));
    await expect(read("alpha", "codex")).resolves.toEqual(
      catalog("other-engine")
    );
    await expect(read("beta", "claude")).resolves.toEqual(
      catalog("other-runner")
    );

    vi.advanceTimersByTime(14_999);
    await expect(read("alpha", "claude")).resolves.toEqual(catalog("one"));
    vi.advanceTimersByTime(1);
    await expect(read("alpha", "claude")).resolves.toEqual(
      catalog("refreshed")
    );
    expect(requestRunner).toHaveBeenCalledTimes(4);
  });

  it("briefly caches a failed lookup and logs it once per probe", async () => {
    vi.useFakeTimers();
    const { read, requestRunner, log } = setup();
    requestRunner
      .mockRejectedValueOnce(new Error("request failed"))
      .mockResolvedValueOnce(catalogReply("recovered"));
    await expect(read("alpha", "claude")).resolves.toBeNull();
    vi.advanceTimersByTime(2_999);
    await expect(read("alpha", "claude")).resolves.toBeNull();
    expect(requestRunner).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await expect(read("alpha", "claude")).resolves.toEqual(
      catalog("recovered")
    );
  });

  it("drops a cached empty catalog on reconnect", async () => {
    const { read, reconnect, requestRunner } = setup();
    const empty = { defaultModel: null, models: [] };
    requestRunner
      .mockResolvedValueOnce({
        value: JSON.stringify({
          ok: true,
          capability: { type: "model_catalog", catalog: empty },
        }),
      })
      .mockResolvedValueOnce(catalogReply("recovered"));
    await expect(read("alpha", "claude")).resolves.toEqual(empty);
    await expect(read("alpha", "claude")).resolves.toEqual(empty);
    expect(requestRunner).toHaveBeenCalledTimes(1);
    reconnect("alpha");
    await expect(read("alpha", "claude")).resolves.toEqual(
      catalog("recovered")
    );
  });

  it("logs an unsupported catalog probe at debug level", async () => {
    const { read, requestRunner, log } = setup();
    requestRunner.mockResolvedValueOnce({
      value: JSON.stringify({ ok: false, unsupported: true }),
    });
    await expect(read("alpha", "claude")).resolves.toBeNull();
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keeps an older in-flight reply out of the cache after reconnect", async () => {
    const { read, reconnect, requestRunner } = setup();
    const old = Promise.withResolvers<ReturnType<typeof catalogReply>>();
    requestRunner
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(catalogReply("new"));
    const beforeReconnect = read("alpha", "claude");
    reconnect("alpha");
    await expect(read("alpha", "claude")).resolves.toEqual(catalog("new"));
    old.resolve(catalogReply("old"));
    await beforeReconnect;
    await expect(read("alpha", "claude")).resolves.toEqual(catalog("new"));
    expect(requestRunner).toHaveBeenCalledTimes(2);
  });

  it.each([
    { type: "install", engine: "claude" },
    { type: "update", engine: "claude" },
    { type: "login_start", engine: "claude" },
    { type: "login_submit", loginId: "login", code: "code" },
    { type: "login_status", loginId: "login" },
  ] as const)("invalidates after $type", async (operation) => {
    const { read, transport, requestRunner } = setup();
    requestRunner
      .mockResolvedValueOnce(catalogReply("before"))
      .mockResolvedValueOnce({
        value: JSON.stringify({ ok: true, login: { status: "succeeded" } }),
      })
      .mockResolvedValueOnce(catalogReply("after"));
    await read("alpha", "claude");
    await transport.send("alpha", operation);
    await expect(read("alpha", "claude")).resolves.toEqual(catalog("after"));
  });
});
