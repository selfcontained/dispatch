import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { runCommand } from "../shared/lib/run-command.js";

export class TmuxTerminal {
  private static readonly SUBMIT_SETTLE_MS = 150;
  private static readonly RETRY_SUBMIT_BYTES = 4 * 1024;
  private static readonly COPY_MODE_STATE_DELIMITER = ":::";
  private static readonly PASTED_TEXT_LINE =
    /^\[Pasted text #[0-9]+(?: \+[0-9]+ lines)?\]$/i;
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

  async getCopyModeState(): Promise<{
    inCopyMode: boolean;
  }> {
    try {
      const paneTarget = await this.resolvePaneTarget();
      const result = await runCommand(
        "tmux",
        ["display-message", "-p", "-t", paneTarget, "#{pane_in_mode}"],
        { allowedExitCodes: [0, 1] }
      );

      if (result.exitCode !== 0) {
        return { inCopyMode: false };
      }

      return {
        inCopyMode: result.stdout.trim() === "1",
      };
    } catch {
      return { inCopyMode: false };
    }
  }

  async exitCopyMode(): Promise<void> {
    const paneTarget = await this.resolvePaneTarget();
    await runCommand("tmux", ["copy-mode", "-q", "-t", paneTarget], {
      allowedExitCodes: [0, 1],
    });
  }

  async getMouseMode(): Promise<"on" | "off" | null> {
    try {
      const result = await runCommand(
        "tmux",
        ["show-options", "-qv", "-t", this.sessionName, "mouse"],
        { allowedExitCodes: [0, 1] }
      );
      const value = result.stdout.trim();
      if (value === "on" || value === "off") {
        return value;
      }
      return null;
    } catch {
      return null;
    }
  }

  async setMouseMode(mode: "on" | "off"): Promise<void> {
    await runCommand(
      "tmux",
      ["set-option", "-t", this.sessionName, "mouse", mode],
      { allowedExitCodes: [0, 1] }
    );
  }

  private async resolvePaneTarget(): Promise<string> {
    const result = await runCommand(
      "tmux",
      ["display-message", "-p", "-t", this.sessionName, "#{pane_id}"],
      { allowedExitCodes: [0, 1] }
    );
    const paneId = result.stdout.trim();
    return result.exitCode === 0 && paneId ? paneId : this.sessionName;
  }

  private findLastPasteMarker(paneText: string): string | null {
    const lines = paneText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => TmuxTerminal.PASTED_TEXT_LINE.test(line));
    return lines.at(-1) ?? null;
  }

  private hasNewTrailingPasteMarker(before: string, after: string): boolean {
    const newestAfter = this.findLastPasteMarker(after);
    if (!newestAfter) {
      return false;
    }

    const trailingLines = after
      .trimEnd()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-3);
    if (!trailingLines.includes(newestAfter)) {
      return false;
    }

    return newestAfter !== this.findLastPasteMarker(before);
  }

  // Inject text into the target tmux pane as a single bracketed paste
  // without pressing Enter. The text appears at the cursor but is not submitted.
  async pasteText(text: string): Promise<void> {
    const sanitized = text.replace(/\x1b\[20[01]~/g, "");
    const bufferName = `dispatch_${randomUUID()}`;
    await this.exitCopyMode().catch(() => undefined);
    await runCommand("tmux", ["set-buffer", "-b", bufferName, "--", sanitized]);
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
      await runCommand("tmux", ["delete-buffer", "-b", bufferName], {
        allowedExitCodes: [0, 1],
      }).catch(() => undefined);
    }
  }

  // Inject `commandLine` into the target tmux pane as a single bracketed paste,
  // then submit with Enter. Bracketed paste lets the receiving TUI (Claude,
  // Codex, etc.) treat the burst as one paste event instead of as live typing —
  // without it, Codex's input handler keeps the input in multi-line mode and
  // the trailing Enter fails to submit.
  async sendCommand(commandLine: string): Promise<void> {
    const shouldRetryLargePaste =
      Buffer.byteLength(commandLine, "utf-8") >=
      TmuxTerminal.RETRY_SUBMIT_BYTES;
    const prePasteSnapshot = shouldRetryLargePaste
      ? await this.captureRecentLines(40).catch(() => "")
      : "";
    await this.pasteText(commandLine);
    await delay(TmuxTerminal.SUBMIT_SETTLE_MS);
    await runCommand("tmux", ["send-keys", "-t", this.sessionName, "Enter"]);
    if (shouldRetryLargePaste) {
      await delay(TmuxTerminal.SUBMIT_SETTLE_MS);
      const recent = await this.captureRecentLines(40).catch(() => "");
      if (this.hasNewTrailingPasteMarker(prePasteSnapshot, recent)) {
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
