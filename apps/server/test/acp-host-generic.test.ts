/**
 * The agent host is generic: a client that knows only the session contract
 * (`@dispatch/runner-protocol/contract` and the v1 codec in
 * `@dispatch/runner-client`) drives it and reads typed events, a prompt's
 * `source` is carried without being read, and the host's own code imports
 * nothing of Dispatch's. Dispatch checks a source when it comes back.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decodeHostFrame } from "@dispatch/runner-client/v1/host";
import { hostMessage } from "@dispatch/runner-protocol/contract";

import { HostClient } from "../src/agents/acp/host-client.js";
import {
  encodeMessage,
  HOST_FILES,
  ndjsonDecoder,
  type HostLaunch,
  type JournalEntry,
} from "../src/agents/acp/host-protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const serverSrc = path.resolve(here, "../src");
const mainTs = path.join(serverSrc, "main.ts");
const fakeAgent = path.join(repoRoot, "e2e/fixtures/fake-acp-agent.mjs");

const until = async (check: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Another product's prompt metadata: nothing Dispatch would write. */
const FOREIGN_SOURCE = { product: "other", ticket: 7, tags: ["a", "b"] };

describe("generic agent host", () => {
  let root: string;
  let dir: string;
  let host: ReturnType<typeof spawn>;

  beforeAll(async () => {
    // Keep the socket path within macOS's Unix socket path limit.
    root = mkdtempSync("/tmp/dispatch-host-generic-");
    dir = path.join(root, "s");
    const cwd = path.join(root, "cwd");
    mkdirSync(dir);
    mkdirSync(cwd);
    const launch: HostLaunch = {
      agentId: "session-1",
      cwd,
      engine: "claude",
      model: null,
      bins: {
        claudeBin: "claude",
        codexBin: null,
        adapter: { bin: fakeAgent },
      },
      systemPrompt: null,
      env: { FAKE_ACP_ENGINE: "claude" },
      pathPrefix: [],
      resumeSessionId: null,
    };
    writeFileSync(path.join(dir, HOST_FILES.launch), JSON.stringify(launch));
    host = spawn("bun", [mainTs, "agent-host", "--state", dir], {
      stdio: "ignore",
    });
    await until(() => existsSync(path.join(dir, HOST_FILES.session)));
  });

  afterAll(async () => {
    if (host.exitCode === null && host.signalCode === null) {
      const exited = once(host, "exit");
      host.kill();
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("is driven by a contract-only client that reads typed events", async () => {
    const socket = net.createConnection(path.join(dir, HOST_FILES.socket));
    const frames: Record<string, unknown>[] = [];
    const decode = ndjsonDecoder<Record<string, unknown>>();
    socket.on("data", (chunk) => frames.push(...decode(chunk)));
    await once(socket, "connect");
    try {
      socket.write(
        encodeMessage({ type: "hello", fromSeq: 0, replayComplete: true })
      );
      await until(() => frames.some((f) => f.type === "replay_complete"));
      const welcome = decodeHostFrame(frames[0]!);
      expect(welcome).toMatchObject({ type: "welcome", running: true });
      socket.write(
        encodeMessage({
          type: "prompt",
          id: "op-1",
          text: "hello from elsewhere",
          source: FOREIGN_SOURCE,
        })
      );
      await until(() =>
        frames.some(
          (f) =>
            f.type === "event" &&
            (f.event as { type: string; state?: string }).type === "turn" &&
            (f.event as { state?: string }).state === "settled"
        )
      );
      const messages = frames.map(decodeHostFrame);
      // Every frame is a contract message, events included.
      for (const message of messages)
        expect(hostMessage.check(message)).toBe(true);
      const started = messages.find(
        (m) =>
          m.type === "event" &&
          m.event.type === "turn" &&
          m.event.state === "started"
      );
      expect(started).toMatchObject({
        event: { text: "hello from elsewhere", source: FOREIGN_SOURCE },
      });
      expect(messages).toContainEqual({ type: "prompt_accepted", id: "op-1" });
    } finally {
      socket.destroy();
    }
  });

  it("hands Dispatch no source it did not write", async () => {
    const entries: JournalEntry[] = [];
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const client = new HostClient({
      agentId: "session-1",
      remote: false,
      openSocket: async () => {
        const socket = net.createConnection(path.join(dir, HOST_FILES.socket));
        await once(socket, "connect");
        return socket;
      },
      logger,
      fromSeq: () => 0,
      journalId: () => null,
      onEvent: (entry) => entries.push(entry),
      onWelcome: () => {},
      onGone: () => {},
    });
    try {
      await client.connect(10_000, undefined, true);
      const started = entries.find(
        (e) => e.event.type === "turn" && e.event.state === "started"
      );
      expect(started?.event).toMatchObject({ text: "hello from elsewhere" });
      expect(started?.event).not.toHaveProperty("source");
      // The journal itself keeps the caller's metadata as sent.
      expect(
        readFileSync(path.join(dir, HOST_FILES.journal), "utf8")
      ).toContain(JSON.stringify(FOREIGN_SOURCE));
    } finally {
      client.close();
    }
  });
});

/**
 * Everything the host process loads, from `agents/acp/host/main.ts`, by
 * static and type imports. Dispatch's own modules stay out; what remains
 * here moves with the host (see the T22 follow-up) or is a host-machine
 * helper the runner keeps.
 */
describe("the host's import closure", () => {
  it("reaches no Dispatch module", () => {
    const seen = new Set<string>();
    const packages = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest
      );
      for (const statement of source.statements) {
        if (
          !(
            ts.isImportDeclaration(statement) ||
            ts.isExportDeclaration(statement)
          ) ||
          !statement.moduleSpecifier ||
          !ts.isStringLiteral(statement.moduleSpecifier)
        )
          continue;
        const specifier = statement.moduleSpecifier.text;
        if (!specifier.startsWith(".")) {
          packages.add(
            specifier.startsWith("node:")
              ? "node:"
              : specifier
                  .split("/")
                  .slice(0, specifier.startsWith("@") ? 2 : 1)
                  .join("/")
          );
          continue;
        }
        const target = path.resolve(path.dirname(file), specifier);
        const resolved = [
          target.replace(/\.js$/, ".ts"),
          target,
          path.join(target, "index.ts"),
        ].find((candidate) => existsSync(candidate));
        if (!resolved)
          throw new Error(`Cannot resolve ${specifier} from ${file}`);
        visit(resolved);
      }
    };
    visit(path.join(serverSrc, "agents/acp/host/main.ts"));
    const files = [...seen]
      .map((file) => path.relative(serverSrc, file))
      .sort();
    expect([...packages].sort()).toEqual([
      "@agentclientprotocol/sdk",
      "@dispatch/runner-protocol",
      "jsonc-parser",
      "node:",
      "zod",
    ]);
    expect(files).toEqual([
      "agents/acp/background-ingress.ts",
      "agents/acp/background-work.ts",
      "agents/acp/driver.ts",
      "agents/acp/engine-bin-dir.ts",
      "agents/acp/engine-spec.ts",
      "agents/acp/host-command.ts",
      "agents/acp/host-env.ts",
      "agents/acp/host-protocol.ts",
      "agents/acp/host/first-prompt.ts",
      "agents/acp/host/launch-effort.ts",
      "agents/acp/host/main.ts",
      "agents/acp/host/mcp-inventory.ts",
      "agents/acp/host/prompt-images.ts",
      "agents/acp/host/types.ts",
      "agents/acp/opencode-instructions.ts",
      "agents/acp/package-bin-dir.ts",
      "agents/acp/permissions.ts",
      "agents/engine-availability.ts",
      "shared/lib/run-command.ts",
      "shared/lib/tool-environment.ts",
      "shared/process/child-environment.js",
      "shared/process/owned-processes.js",
    ]);
  });
});
