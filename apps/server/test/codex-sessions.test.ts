import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  codexSessionsDir,
  findCodexSessionId,
} from "../src/agents/codex-sessions.js";

/** Minimal stand-in for a real rollout file: session_meta header + tagged prompt. */
function rolloutLines(sessionId: string, agentId: string | null): string {
  const lines = [
    JSON.stringify({
      timestamp: "2026-08-10T10:00:00.000Z",
      type: "session_meta",
      payload: { session_id: sessionId, id: sessionId, cwd: "/tmp" },
    }),
    JSON.stringify({
      timestamp: "2026-08-10T10:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: agentId
              ? `[dispatch:${agentId}] Dispatch startup rules:\n1. Do things.`
              : "hello with no dispatch tag",
          },
        ],
      },
    }),
  ];
  return lines.join("\n") + "\n";
}

describe("codex-sessions", () => {
  let codexHome: string;

  beforeEach(async () => {
    codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-home-"));
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(async () => {
    delete process.env.CODEX_HOME;
    await rm(codexHome, { recursive: true, force: true });
  });

  async function writeRollout(
    day: string,
    sessionId: string,
    agentId: string | null,
    mtime?: Date
  ): Promise<string> {
    const dir = path.join(codexSessionsDir(), ...day.split("/"));
    await mkdir(dir, { recursive: true });
    const file = path.join(
      dir,
      `rollout-${day.replaceAll("/", "-")}T10-00-00-${sessionId}.jsonl`
    );
    await writeFile(file, rolloutLines(sessionId, agentId));
    if (mtime) await utimes(file, mtime, mtime);
    return file;
  }

  describe("codexSessionsDir", () => {
    it("honours CODEX_HOME", () => {
      expect(codexSessionsDir()).toBe(path.join(codexHome, "sessions"));
    });

    it("falls back to ~/.codex when CODEX_HOME is unset", () => {
      delete process.env.CODEX_HOME;
      expect(codexSessionsDir()).toBe(
        path.join(os.homedir(), ".codex", "sessions")
      );
    });
  });

  describe("findCodexSessionId", () => {
    it("returns null when there are no rollouts at all", async () => {
      expect(await findCodexSessionId("agt_missing")).toBeNull();
    });

    it("finds the session id from the rollout tagged with the agent id", async () => {
      await writeRollout(
        "2026/08/10",
        "019fec26-8f60-7513-b82c-cdb5cba76b1b",
        "agt_abc123"
      );
      expect(await findCodexSessionId("agt_abc123")).toBe(
        "019fec26-8f60-7513-b82c-cdb5cba76b1b"
      );
    });

    it("ignores rollouts belonging to other agents", async () => {
      await writeRollout(
        "2026/08/10",
        "019fec26-8f60-7513-b82c-cdb5cba76b1b",
        "agt_other"
      );
      await writeRollout(
        "2026/08/10",
        "019fec26-0000-0000-0000-000000000000",
        null
      );
      expect(await findCodexSessionId("agt_abc123")).toBeNull();
    });

    it("prefers the most recently modified rollout when an agent has several", async () => {
      await writeRollout(
        "2026/08/09",
        "11111111-1111-1111-1111-111111111111",
        "agt_abc123",
        new Date("2026-08-09T10:00:00Z")
      );
      await writeRollout(
        "2026/08/10",
        "22222222-2222-2222-2222-222222222222",
        "agt_abc123",
        new Date("2026-08-10T10:00:00Z")
      );
      expect(await findCodexSessionId("agt_abc123")).toBe(
        "22222222-2222-2222-2222-222222222222"
      );
    });

    it("skips rollouts older than the agent (with a day of clock slack)", async () => {
      await writeRollout(
        "2026/08/01",
        "33333333-3333-3333-3333-333333333333",
        "agt_abc123",
        new Date("2026-08-01T10:00:00Z")
      );
      const found = await findCodexSessionId("agt_abc123", {
        notBefore: new Date("2026-08-10T10:00:00Z"),
      });
      expect(found).toBeNull();
    });

    it("keeps a rollout written just before the agent's recorded creation time", async () => {
      await writeRollout(
        "2026/08/10",
        "44444444-4444-4444-4444-444444444444",
        "agt_abc123",
        new Date("2026-08-10T09:00:00Z")
      );
      const found = await findCodexSessionId("agt_abc123", {
        notBefore: new Date("2026-08-10T10:00:00Z"),
      });
      expect(found).toBe("44444444-4444-4444-4444-444444444444");
    });

    it("falls back to the filename UUID when the header is unparseable", async () => {
      const dir = path.join(codexSessionsDir(), "2026", "08", "10");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(
          dir,
          "rollout-2026-08-10T10-00-00-55555555-5555-5555-5555-555555555555.jsonl"
        ),
        "not json\n[dispatch:agt_abc123] Dispatch startup rules:\n"
      );
      expect(await findCodexSessionId("agt_abc123")).toBe(
        "55555555-5555-5555-5555-555555555555"
      );
    });

    it("does not match a tag that appears far into the rollout", async () => {
      const dir = path.join(codexSessionsDir(), "2026", "08", "10");
      await mkdir(dir, { recursive: true });
      const filler = Array.from({ length: 40 }, () => "{}").join("\n");
      await writeFile(
        path.join(
          dir,
          "rollout-2026-08-10T10-00-00-66666666-6666-6666-6666-666666666666.jsonl"
        ),
        `${filler}\n[dispatch:agt_abc123] late tag\n`
      );
      expect(await findCodexSessionId("agt_abc123")).toBeNull();
    });
  });
});
