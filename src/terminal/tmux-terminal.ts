import { createHash } from "node:crypto";

import { runCommand } from "../lib/run-command.js";

export class TmuxTerminal {
  private readonly sessionName: string;

  constructor(sessionName: string) {
    this.sessionName = sessionName;
  }

  async hasSession(): Promise<boolean> {
    const result = await runCommand("tmux", ["has-session", "-t", this.sessionName], {
      allowedExitCodes: [0, 1]
    });

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
      "-1"
    ]);

    return result.stdout;
  }

  async sendCommand(commandLine: string): Promise<void> {
    await runCommand("tmux", ["send-keys", "-t", this.sessionName, "-l", commandLine]);
    await runCommand("tmux", ["send-keys", "-t", this.sessionName, "Enter"]);
  }

  digest(contents: string): string {
    return createHash("sha1").update(contents).digest("hex");
  }
}
