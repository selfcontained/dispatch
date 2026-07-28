import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCommandMock = vi.fn(async () => undefined);

vi.mock("../src/terminal/tmux-terminal.js", () => ({
  TmuxTerminal: class {
    constructor(_sessionName: string) {}

    sendCommand = sendCommandMock;
  },
}));

const { createPromptInjector } = await import("../src/server/agent-prompts.js");

describe("createPromptInjector", () => {
  const getTerminalAccess = vi.fn();
  const agentManager = { getTerminalAccess };
  const appLog = { debug: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables the large-paste Enter retry for OpenCode", async () => {
    getTerminalAccess.mockResolvedValue({
      mode: "tmux",
      sessionName: "dispatch_opencode",
      agentType: "opencode",
    });

    await createPromptInjector(agentManager as never, appLog as never)(
      "agt_1",
      "x".repeat(5000),
      { swallowFailure: false }
    );

    expect(sendCommandMock).toHaveBeenCalledWith("x".repeat(5000), {
      retryLargePaste: false,
    });
  });

  it("keeps the large-paste retry enabled for Codex and Claude", async () => {
    getTerminalAccess.mockResolvedValue({
      mode: "tmux",
      sessionName: "dispatch_codex",
      agentType: "codex",
    });

    await createPromptInjector(agentManager as never, appLog as never)(
      "agt_2",
      "x".repeat(5000),
      { swallowFailure: false }
    );

    expect(sendCommandMock).toHaveBeenCalledWith("x".repeat(5000), {
      retryLargePaste: true,
    });
  });
});
