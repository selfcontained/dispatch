import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { runCommand } from "./run-command.js";

let lastXclipPid: number | null = null;

async function waitForClipboardSelection(
  display: string,
  mime: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runCommand(
      "xclip",
      ["-selection", "clipboard", "-o", "-t", "TARGETS"],
      {
        env: { ...process.env, DISPLAY: display },
        timeoutMs: 1_000,
        allowedExitCodes: [0, 1],
      }
    ).catch(() => null);
    if (result && result.exitCode === 0 && result.stdout.includes(mime)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/**
 * Write an image buffer to the host clipboard so an agent CLI can paste it
 * inline via Ctrl+V.
 *
 * macOS: writes to a temp file and uses osascript to set the pasteboard.
 * Linux: pipes to xclip's stdin and polls until xclip owns the selection.
 *
 * Throws on failure — callers should catch and fall back to path-based delivery.
 */
export async function writeImageToClipboard(
  buffer: Buffer,
  mime: string
): Promise<void> {
  if (os.platform() === "darwin") {
    const ext =
      mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "png";
    const dir = await mkdtemp(path.join(os.tmpdir(), "dispatch-clip-"));
    const tmpPath = path.join(dir, `clipboard.${ext}`);
    try {
      await writeFile(tmpPath, buffer);
      const pasteboardClass = ext === "jpg" ? "JPEG" : "PNGf";
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("osascript", [
          "-e",
          `set the clipboard to (read (POSIX file "${tmpPath}") as «class ${pasteboardClass}»)`,
        ]);
        proc.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`osascript exited ${code}`))
        );
        proc.on("error", reject);
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return;
  }

  // Linux path
  const display = process.env.DISPATCH_COPY_DISPLAY as string;
  if (lastXclipPid !== null) {
    try {
      process.kill(lastXclipPid, "SIGTERM");
    } catch {}
    lastXclipPid = null;
  }
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("xclip", ["-selection", "clipboard", "-t", mime], {
      env: { ...process.env, DISPLAY: display },
      stdio: ["pipe", "ignore", "pipe"],
      detached: true,
    });
    lastXclipPid = proc.pid ?? null;
    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("error", reject);
    let settled = false;
    proc.on("exit", (code) => {
      if (lastXclipPid === proc.pid) lastXclipPid = null;
      // Use `code != null` instead of `code` so signal-killed
      // xclip (code === null) isn't silently swallowed as success.
      if (!settled && code != null && code !== 0) {
        settled = true;
        reject(new Error(`xclip exited ${code}: ${stderr.trim()}`));
      }
    });
    proc.stdin?.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    proc.stdin?.end(buffer, () => {
      void waitForClipboardSelection(display, mime, 2_000).then((owned) => {
        if (settled) return;
        settled = true;
        proc.unref();
        if (owned) {
          resolve();
        } else {
          reject(new Error("xclip did not take the clipboard selection"));
        }
      });
    });
  });
}
