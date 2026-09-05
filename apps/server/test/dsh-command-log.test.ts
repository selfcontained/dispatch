import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendCommandLog,
  commandLogPath,
  formatCommandLogEntry,
} from "../src/agents/dsh/command-log.js";

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("command log", () => {
  it("formats a prompt line, the output, and a footer", () => {
    const text = formatCommandLogEntry({
      command: "ls apps",
      output: "server\nweb\n",
      status: "completed",
      durationMs: 152,
      at: new Date("2026-09-05T10:00:00Z"),
    });
    expect(text).toContain("$\u001b[0m ls apps");
    expect(text).toContain("server\nweb\n");
    expect(text).toContain("ok");
    expect(text).toContain("152ms");
    expect(text.endsWith("\n\n")).toBe(true);
  });

  it("appends under the harness home, creating the directory", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dsh-log-"));
    const file = commandLogPath(dir, "agt_1");
    expect(file).toBe(path.join(dir, "logs", "agt_1.log"));
    await appendCommandLog(file, {
      command: "git status",
      output: null,
      status: "failed",
      durationMs: 5,
      at: new Date(),
    });
    await appendCommandLog(file, {
      command: "pwd",
      output: "/w",
      status: "completed",
      durationMs: 1,
      at: new Date(),
    });
    const text = await readFile(file, "utf8");
    expect(text).toContain("git status");
    expect(text).toContain("failed");
    expect(text).toContain("/w");
  });
});
