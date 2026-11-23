/*
 * Session host frames as the v1 host and its callers send them today, taken
 * from the host (`apps/server/src/agents/acp/host/main.ts`) and the host,
 * driver, runtime and client tests under `apps/server/test/acp-*`.
 */
export const agentId = "agt_fixture1";
const at = "2026-11-22T10:00:00.000Z";
const journalId = "journal-1";
const source = { source: "engine", text: "on its own" };
const permission = {
  id: "perm-1",
  toolCallId: "tool-1",
  title: "Run ls",
  details: "ls -la",
  createdAt: at,
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
};
const configOptions = [
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "opus",
    options: [{ value: "opus", name: "Opus" }],
  },
];

export const clientFrames: Record<string, unknown>[] = [
  { type: "hello", fromSeq: 0 },
  { type: "hello", fromSeq: 12, journalId, replayComplete: true },
  { type: "hello", fromSeq: 0, journalId: null },
  { type: "prompt", id: "p-1", text: "hi" },
  {
    type: "prompt",
    id: "p-2",
    text: "look",
    journalId,
    source,
    images: [{ path: "/tmp/a.png", mimeType: "image/png" }],
  },
  { type: "steer", id: "s-1", text: "also", source },
  { type: "cancel" },
  { type: "interrupt", id: "i-1", turnSeq: 4 },
  { type: "answer_permission", id: "a-1", requestId: "perm-1", optionId: null },
  { type: "set_config", id: "c-1", configId: "model", value: "sonnet" },
  { type: "shutdown" },
  { type: "shutdown", force: true },
  { type: "shutdown", idleOnly: true },
  { type: "shutdown", quiesceId: "q-1" },
  { type: "mcp_inventory", id: "m-1", sessionId: "sess" },
  { type: "background_work", id: "b-1", sessionId: "sess" },
  { type: "ping" },
  { type: "prompt_receipt", id: "p-1", journalId },
  { type: "quiesce", id: "q-1" },
  { type: "release_quiesce", id: "q-1" },
];

const event = (
  seq: number,
  e: Record<string, unknown>,
  withJournal = true
) => ({
  type: "event",
  seq,
  at,
  event: { type: e.type, agentId, ...e },
  ...(withJournal && { journalId }),
});

export const hostFrames: Record<string, unknown>[] = [
  // A runtime test's minimal welcome, and the host's full one.
  {
    type: "welcome",
    agentId,
    engine: "claude",
    sessionId: "sess",
    resumed: false,
    running: true,
    turn: null,
    journalSeq: 0,
  },
  {
    type: "welcome",
    hostInstanceId: "host-1",
    hostBuild: { version: "1.2.3", revision: null },
    agentId,
    engine: "codex",
    sessionId: "sess",
    resumed: true,
    running: true,
    mcpInventorySupported: true,
    backgroundWorkSupported: true,
    steeringSupported: true,
    interruptSupported: true,
    promptReceiptSupported: true,
    quiesceSupported: true,
    turn: { seq: 7, startedAt: at, source },
    journalSeq: 9,
    journalId,
    commands: [{ name: "review", description: "Review", input: null }],
    configOptions,
    permissions: [permission],
  },
  event(1, {
    type: "turn",
    state: "started",
    text: "hi",
    source,
    model: "opus",
    sessionId: "sess",
  }),
  event(2, {
    type: "update",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    },
  }),
  event(3, { type: "steered", text: "also", source, receiptId: "s-1", at }),
  event(4, { type: "prompt_delivered", receiptId: "p-1", source, at }),
  event(5, { type: "steering_picked_up", receiptId: "s-1", at }),
  event(6, { type: "config", options: configOptions, catalogSource: "engine" }),
  event(7, {
    type: "turn",
    state: "settled",
    stopReason: "end_turn",
    usage: { totalTokens: 18, inputTokens: 5, outputTokens: 3 },
  }),
  event(8, {
    type: "turn",
    state: "settled",
    error: "overloaded",
    errorKind: "overloaded",
  }),
  event(
    9,
    {
      type: "exit",
      code: null,
      signal: "SIGTERM",
      stderrTail: "",
      expected: true,
    },
    false
  ),
  // The seq 0 live permission snapshot (never journaled).
  event(0, { type: "permissions", requests: [permission] }, false),
  { type: "replay_complete" },
  { type: "prompt_accepted", id: "p-1" },
  { type: "prompt_deferred", id: "p-2" },
  { type: "interrupt_result", id: "i-1" },
  { type: "steer_result", id: "s-1", outcome: "injected" },
  { type: "steer_result", id: "s-2", outcome: "promptRequired" },
  { type: "error", message: "engine failed to start" },
  { type: "error", id: "x", message: "Invalid host command." },
  { type: "permission_answered", id: "a-1" },
  { type: "pong" },
  {
    type: "prompt_receipt_result",
    id: "p-1",
    journalId,
    state: "claimed",
  },
  { type: "quiesce_result", id: "q-1", state: "idle" },
  { type: "quiesce_shutdown_result", id: "q-1", accepted: false },
  { type: "config_set", id: "c-1", options: configOptions },
  { type: "permissions", requests: [permission] },
  {
    type: "mcp_inventory_result",
    id: "m-1",
    result: {
      agentId,
      status: "ok",
      inventory: {
        version: 1,
        servers: [
          {
            name: "files",
            state: "connected",
            toolsState: "known",
            tools: [{ name: "post", description: "Post" }, { name: "get" }],
          },
          { name: "other", state: "failed", toolsState: "error", tools: null },
        ],
      },
    },
  },
  {
    type: "mcp_inventory_result",
    id: "m-2",
    result: { agentId, status: "offline", inventory: null },
  },
  {
    type: "background_work_result",
    id: "b-1",
    result: {
      status: "supported",
      items: [{ id: "bg-1", name: "tail", kind: "shell", state: "running" }],
    },
  },
];
