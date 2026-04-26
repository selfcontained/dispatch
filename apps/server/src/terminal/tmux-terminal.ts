import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { runCommand } from "../shared/lib/run-command.js";

export class TmuxTerminal {
  private static readonly SUBMIT_SETTLE_MS = 150;
  private static readonly RETRY_SUBMIT_BYTES = 4 * 1024;
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
    // Strip bracketed-paste markers from the input. \x1b[201~ closes the paste
    // span; without this, attacker-influenced fields (persona name, child
    // reviewer feedback summaries, raw diff bytes) could end the paste early
    // and inject the trailing bytes as live keystrokes — Ctrl-C / Ctrl-D into
    // the receiving TUI, a cross-agent disruption channel.
    const sanitized = commandLine.replace(/\x1b\[20[01]~/g, "");
    const bufferName = `dispatch_${randomUUID()}`;
    await runCommand("tmux", ["set-buffer", "-b", bufferName, sanitized]);
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
    } finally {
      // paste-buffer -d already deletes on success, so this is a no-op then
      // (exit 1 = buffer doesn't exist). On any failure between set-buffer
      // and successful paste, the named buffer would otherwise leak.
      await runCommand("tmux", ["delete-buffer", "-b", bufferName], {
        allowedExitCodes: [0, 1],
      }).catch(() => undefined);
    }
    await delay(TmuxTerminal.SUBMIT_SETTLE_MS);
    await runCommand("tmux", ["send-keys", "-t", this.sessionName, "Enter"]);
    if (
      Buffer.byteLength(sanitized, "utf-8") >= TmuxTerminal.RETRY_SUBMIT_BYTES
    ) {
      await delay(TmuxTerminal.SUBMIT_SETTLE_MS);
      const recent = await this.captureRecentLines(40).catch(() => "");
      if (/\[Pasted text #[0-9]+/i.test(recent)) {
        await runCommand("tmux", [
          "send-keys",
          "-t",
          this.sessionName,
          "Enter",
        ]);
      }
    }
  }

  digest(contents: string): string {
    return createHash("sha1").update(contents).digest("hex");
  }
}
