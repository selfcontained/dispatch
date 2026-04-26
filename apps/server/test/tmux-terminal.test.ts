import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runCommandMock = vi.fn(async () => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: runCommandMock,
}));

const { TmuxTerminal } = await import("../src/terminal/tmux-terminal.js");

beforeEach(() => {
  runCommandMock.mockClear();
  runCommandMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
});

afterEach(() => {
  runCommandMock.mockReset();
});

describe("TmuxTerminal.sendCommand", () => {
  function setBufferCalls(): string[] {
    return runCommandMock.mock.calls
      .filter(([, args]) => Array.isArray(args) && args[0] === "set-buffer")
      .map(([, args]) => (args as string[])[3] ?? "");
  }

  it("strips bracketed-paste end markers before passing to set-buffer", async () => {
    const terminal = new TmuxTerminal("session-x");
    const malicious = `safe text\x1b[201~rm -rf /\x1b[201~more`;
    await terminal.sendCommand(malicious);

    const buffers = setBufferCalls();
    expect(buffers).toHaveLength(1);
    expect(buffers[0]).not.toContain("\x1b[201~");
    expect(buffers[0]).toBe("safe textrm -rf /more");
  });

  it("strips bracketed-paste start markers as well", async () => {
    const terminal = new TmuxTerminal("session-x");
    await terminal.sendCommand(`a\x1b[200~b\x1b[201~c`);

    expect(setBufferCalls()[0]).toBe("abc");
  });

  it("leaves benign content untouched", async () => {
    const terminal = new TmuxTerminal("session-x");
    const text = "Begin your review now.\nLine two.\n```diff\n+x\n```";
    await terminal.sendCommand(text);

    expect(setBufferCalls()[0]).toBe(text);
  });

  it("always attempts buffer cleanup, even when paste-buffer succeeds", async () => {
    const terminal = new TmuxTerminal("session-x");
    await terminal.sendCommand("hello");

    const deleteCalls = runCommandMock.mock.calls.filter(
      ([, args]) => Array.isArray(args) && args[0] === "delete-buffer"
    );
    expect(deleteCalls).toHaveLength(1);
  });

  it("attempts buffer cleanup even when paste-buffer throws", async () => {
    runCommandMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "paste-buffer") {
        throw new Error("paste failed");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const terminal = new TmuxTerminal("session-x");
    await expect(terminal.sendCommand("hello")).rejects.toThrow("paste failed");

    const deleteCalls = runCommandMock.mock.calls.filter(
      ([, args]) => Array.isArray(args) && args[0] === "delete-buffer"
    );
    expect(deleteCalls).toHaveLength(1);
  });

  it("does not raise if delete-buffer itself fails after a successful paste", async () => {
    runCommandMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "delete-buffer") {
        throw new Error("buffer gone");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const terminal = new TmuxTerminal("session-x");
    await expect(terminal.sendCommand("hello")).resolves.toBeUndefined();
  });
});
