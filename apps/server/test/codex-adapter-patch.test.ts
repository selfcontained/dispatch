import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The published Codex adapter is a CLI-only bundle with no exports. Expose its
// installed classes and remove only CLI startup; all exercised methods remain
// the installed patched implementation. No Codex process or model is started.
let tempDir: string;
let adapter: {
  CodexEventHandler: { prototype: any };
  CodexAcpClient: { prototype: any };
  CodexAcpServer: { prototype: any };
};
beforeAll(async () => {
  const sourcePath = createRequire(import.meta.url).resolve(
    "@agentclientprotocol/codex-acp"
  );
  const source = await readFile(sourcePath, "utf8");
  const entrypoint = source.indexOf('if (process.argv.includes("--version"))');
  expect(entrypoint).toBeGreaterThan(0);
  tempDir = await mkdtemp(path.join(os.tmpdir(), "dispatch-codex-patch-"));
  const modulePath = path.join(tempDir, "adapter.mjs");
  await writeFile(
    modulePath,
    source
      .slice(0, entrypoint)
      .replaceAll(
        "import.meta.url",
        JSON.stringify(pathToFileURL(sourcePath).href)
      ) + "\nexport { CodexEventHandler, CodexAcpClient, CodexAcpServer };\n"
  );
  adapter = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
});
afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

const receiptId = "a1234567-0000-4000-8000-000000000000";
const params = {
  sessionId: "session-1",
  prompt: [{ type: "text", text: "Correction" }],
  _meta: {
    "dispatch/steering": { id: receiptId },
    steering: { idleBehavior: "promptRequired" },
  },
};

describe("installed Codex adapter Dispatch contracts", () => {
  it("publishes turn start/completion ids, status and error", async () => {
    const sessionState = {
      currentTurnId: null,
      toolCallReports: { releaseOpen: vi.fn() },
    };
    const handler = {
      sessionState,
      flushPendingErrors: vi.fn(),
      plans: { flush: vi.fn(), clearTurn: vi.fn() },
      subagents: { notificationSessionId: () => params.sessionId },
    };
    const event = adapter.CodexEventHandler.prototype.createUpdateEvent;
    const turn = {
      id: "turn-1",
      status: "failed",
      error: { message: "failure" },
    };
    expect(
      await event.call(handler, { method: "turn/started", params: { turn } })
    ).toEqual({
      sessionUpdate: "session_info_update",
      _meta: {
        "dispatch/turn": { state: "started", turnId: turn.id },
      },
    });
    expect(sessionState.currentTurnId).toBe(turn.id);
    expect(
      await event.call(handler, { method: "turn/completed", params: { turn } })
    ).toEqual({
      sessionUpdate: "session_info_update",
      _meta: {
        "dispatch/turn": {
          state: "completed",
          turnId: turn.id,
          status: "failed",
          error: "failure",
        },
      },
    });
    expect(sessionState.currentTurnId).toBeNull();
  });

  it("emits pickup only for the user message's client id", async () => {
    const event = adapter.CodexEventHandler.prototype.createItemEvent;
    expect(
      await event.call(
        {},
        { item: { type: "userMessage", clientId: receiptId } }
      )
    ).toEqual({
      sessionUpdate: "session_info_update",
      _meta: {
        "dispatch/steering": { pickedUp: receiptId },
      },
    });
    expect(
      await event.call({}, { item: { type: "userMessage", id: receiptId } })
    ).toBeNull();
  });

  it("forwards prompt and steer receipts as clientUserMessageId", async () => {
    const runTurn = vi.fn();
    const turnSteer = vi.fn();
    const client = {
      codexClient: { runTurn, turnSteer },
      refreshSkills: vi.fn(),
    };
    await adapter.CodexAcpClient.prototype.sendPrompt.call(
      client,
      params,
      { sandboxPolicy: { type: "dangerFullAccess" } },
      { model: "test" },
      undefined,
      false,
      "/tmp",
      []
    );
    await adapter.CodexAcpClient.prototype.steerTurn.call(client, {
      threadId: params.sessionId,
      turnId: "turn-1",
      prompt: params.prompt,
      receiptId,
    });
    expect(runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: params.sessionId,
        clientUserMessageId: receiptId,
      }),
      undefined
    );
    expect(turnSteer).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: params.sessionId,
        expectedTurnId: "turn-1",
        clientUserMessageId: receiptId,
      })
    );
  });

  it("preserves steering metadata and returns promptRequired without starting a turn", async () => {
    const proto = adapter.CodexAcpServer.prototype;
    // Parse the actual extension params before delivery, as the CLI does.
    const parsed = proto.parseSessionSteerParams.call({}, params);
    expect(parsed._meta).toEqual(params._meta);
    const startNewTurnFromSteering = vi.fn();
    await expect(
      proto.performSteeringRequest.call(
        {
          getSessionState: () => ({ supportedInputModalities: ["text"] }),
          assertSteerInputSupported: proto.assertSteerInputSupported,
          getSteerableTurnId: async () => null,
          startNewTurnFromSteering,
        },
        parsed
      )
    ).resolves.toEqual({ outcome: "promptRequired", reason: "noRunningTurn" });
    expect(startNewTurnFromSteering).not.toHaveBeenCalled();
  });

  it("forwards steer receipt through active-turn injection", async () => {
    const steerTurn = vi.fn();
    await adapter.CodexAcpServer.prototype.injectSteerIntoActiveTurn.call(
      {
        runWithProcessCheck: (fn: () => unknown) => fn(),
        codexAcpClient: { steerTurn },
      },
      params,
      "turn-1",
      {}
    );
    expect(steerTurn).toHaveBeenCalledWith({
      threadId: params.sessionId,
      turnId: "turn-1",
      prompt: params.prompt,
      receiptId,
    });
  });

  it("returns the prompt's own turn id and preserves response metadata", async () => {
    const onTurnStarted = vi.fn();
    const response = { stopReason: "end_turn", _meta: { other: true } };
    const result = await adapter.CodexAcpServer.prototype.prompt.call(
      {
        promptTurn: async (
          _params: unknown,
          _signal: unknown,
          started: (id: string) => void
        ) => {
          started("prompt-turn");
          return response;
        },
      },
      params,
      undefined,
      onTurnStarted
    );
    expect(onTurnStarted).toHaveBeenCalledWith("prompt-turn");
    expect(result).toEqual({
      ...response,
      _meta: {
        other: true,
        "dispatch/turn": { turnId: "prompt-turn" },
      },
    });
  });
});
