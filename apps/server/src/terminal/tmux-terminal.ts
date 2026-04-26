import { createHash, randomUUID } from "node:crypto";

import { runCommand } from "../shared/lib/run-command.js";

export class TmuxTerminal {
  private readonly sessionName: string;

  constructor(sessionName: string) {
    this.sessionName = sessionName;
  }

  async hasSession(): Promise<boolean> {
    const result = await runCommand(
      "tmux",
      ["has-session", "-t", this.sessionName],
      {
        allowedExitCodes: [0, 1],
      }
    );

    return result.exitCode === 0;
  }

  async captureRecentLines(lines = 200): Promise<string> {
    const result = await runCommand("tmux", [
      "capture-pane",
      "-p",
      "-t",
      this.sessionName,
      "-S",
      `-${lines}`,
      "-E",
      "-1",
    ]);

    return result.stdout;
  }

  // Inject `commandLine` into the target tmux pane as a single bracketed paste,
  // then submit with Enter. Bracketed paste lets the receiving TUI (Claude,
  // Codex, etc.) treat the burst as one paste event instead of as live typing —
  // without it, Codex's input handler keeps the input in multi-line mode and
  // the trailing Enter fails to submit.
  async sendCommand(commandLine: string): Promise<void> {
    const bufferName = `dispatch_${randomUUID()}`;
    await runCommand("tmux", ["set-buffer", "-b", bufferName, commandLine]);
    try {
      await runCommand("tmux", [
        "paste-buffer",
        "-t",
        this.sessionName,
        "-b",
        bufferName,
        "-p",
        "-d",
      ]);
    } catch (error) {
      await runCommand("tmux", ["delete-buffer", "-b", bufferName], {
        allowedExitCodes: [0, 1],
      });
      throw error;
    }
    await runCommand("tmux", ["send-keys", "-t", this.sessionName, "Enter"]);
  }

  digest(contents: string): string {
    return createHash("sha1").update(contents).digest("hex");
  }
}
