/**
 * Goldens for what an agent host gives its engine and writes to disk,
 * captured from the host before it was made generic (T22). A host started
 * by an older build and one started by this build must be indistinguishable
 * to the engine: the launcher's argv, the adapter's argv and environment,
 * every JSON-RPC message the host writes to the adapter (so the system
 * prompt and the first prompt, byte for byte), the source journaled on each
 * turn, and the files in the host's directory.
 *
 * Set UPDATE_ACP_HOST_GOLDENS=1 to rewrite the fixtures; never do that to
 * make a change pass.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  hostCommand,
  loginShellCommand,
} from "@dispatch/runner/host/host-command";
import { HOST_FILES } from "@dispatch/runner-client/host-framing";
import type { PromptSource } from "../src/agents/acp/prompt-source.js";
import { createAcpRuntime } from "../src/agents/acp/runtime.js";
import type { DriverEvent } from "@dispatch/runner/host/driver";
import type { RuntimeLaunch } from "../src/agents/runtime.js";
import {
  localRunnerFor,
  stopLocalRunners,
} from "./helpers/local-runner-child.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const mainTs = path.resolve(here, "../src/main.ts");
const recorder = path.join(here, "fixtures/acp-recording-adapter.mjs");
const goldenFile = (name: string) =>
  path.join(here, `fixtures/acp-host-golden-${name}.json`);
const update = process.env.UPDATE_ACP_HOST_GOLDENS === "1";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => logger,
  level: "silent",
} as unknown as Parameters<typeof createAcpRuntime>[0]["logger"];

function expectGolden(name: string, actual: unknown) {
  const file = goldenFile(name);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (update || !existsSync(file)) writeFileSync(file, text);
  expect(JSON.parse(text)).toEqual(JSON.parse(readFileSync(file, "utf8")));
}

const until = async (check: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/**
 * Environment the host and its launch set or remove for the engine, by
 * engine; the rest is the user's shell, which differs per machine.
 */
const COMMON_ENV = [
  "DISPATCH_ACP_ADAPTER_COMMAND",
  "DISPATCH_LOCAL_CA_CERTIFICATE",
  "DISPATCH_GOLDEN_LAUNCH_VALUE",
  "FAKE_ACP_ENGINE",
  "RECORD_DIR",
];
const ENGINE_ENV = {
  claude: ["CLAUDE_CODE_EXECUTABLE", "CLAUDE_CODE_ARTIFACT"],
  codex: ["INITIAL_AGENT_MODE", "NO_BROWSER", "CODEX_PATH"],
  opencode: ["OPENCODE_CONFIG_CONTENT"],
};
const CA_ENV = [
  "NODE_EXTRA_CA_CERTS",
  "CODEX_CA_CERTIFICATE",
  "CURL_CA_BUNDLE",
];

const SOURCE: PromptSource = {
  source: "chat",
  chatMessageId: "msg_first",
  userMessage: true,
  conversation: { streamId: "stream_1", threadId: null },
};

type Case = {
  engine: "claude" | "codex" | "opencode";
  systemPrompt: string;
  personaContext: string | null;
  env?: Record<string, string>;
};

const SYSTEM = 'Be brief.\nÜnïcode ✓ — "quoted" and\ttabbed.';
const CASES: Case[] = [
  {
    engine: "claude",
    systemPrompt: SYSTEM,
    personaContext: "Persona: review only the parent's diff.",
  },
  {
    engine: "codex",
    systemPrompt: SYSTEM,
    // Over the inline budget: the host is told to read a file instead.
    personaContext: "Persona rule ✓\n".repeat(6000),
  },
  {
    engine: "opencode",
    systemPrompt: SYSTEM,
    personaContext: "Persona: review only the parent's diff.",
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        instructions: ["/etc/existing-instructions.md"],
      }),
    },
  },
];

describe("agent host goldens", () => {
  let root: string;
  let cwd: string;
  let ca: string;
  const previousCommand = process.env.DISPATCH_AGENT_HOST_COMMAND;

  beforeAll(() => {
    // Keep the socket path within macOS's Unix socket path limit.
    root = mkdtempSync("/tmp/dispatch-host-golden-");
    cwd = path.join(root, "cwd");
    mkdirSync(cwd);
    ca = path.join(root, "local-ca.pem");
    writeFileSync(ca, rootCertificates[0]!);
    process.env.DISPATCH_AGENT_HOST_COMMAND = JSON.stringify([
      process.execPath.includes("bun") ? process.execPath : "bun",
      mainTs,
      "agent-host",
    ]);
  });

  afterAll(async () => {
    await stopLocalRunners();
    if (previousCommand === undefined)
      delete process.env.DISPATCH_AGENT_HOST_COMMAND;
    else process.env.DISPATCH_AGENT_HOST_COMMAND = previousCommand;
    rmSync(root, { recursive: true, force: true });
  });

  it("starts the host with the same launcher argv", () => {
    const command = ["<exec>", "<main>", "agent-host", "--state", "<dir>"];
    expectGolden("argv", {
      selfCommand: hostCommand({}).map((part) =>
        part === process.execPath
          ? "<execPath>"
          : part === process.argv[1]
            ? "<script>"
            : part
      ),
      override: {
        json: hostCommand({
          DISPATCH_AGENT_HOST_COMMAND: '["bun","main.ts","agent-host"]',
        }),
        words: hostCommand({
          DISPATCH_AGENT_HOST_COMMAND: "bun  main.ts agent-host",
        }),
      },
      shells: Object.fromEntries(
        ["/bin/zsh", "/bin/bash", "/bin/sh", "/usr/bin/fish", "/bin/tcsh"].map(
          (shell) => [
            shell,
            {
              plain: loginShellCommand(command, shell),
              fallback: loginShellCommand(command, shell, "/opt/fallback/bin"),
            },
          ]
        )
      ),
    });
  });

  for (const testCase of CASES) {
    it(`gives ${testCase.engine} the same argv, environment, prompts and files`, async () => {
      const agentId = `agt_golden_${testCase.engine}`;
      const stateRoot = path.join(root, `state-${testCase.engine}`);
      const record = path.join(root, `record-${testCase.engine}`);
      mkdirSync(stateRoot);
      mkdirSync(record);
      const events: DriverEvent[] = [];
      const runtime = createAcpRuntime({
        config: {
          agentStateRoot: stateRoot,
          agentRuntime: "acp",
          acpAdapter: { bin: recorder, args: ["--golden-arg"] },
          dispatchBinDir: path.join(repoRoot, "bin"),
        },
        logger,
        hostSeq: async () => ({ seq: 0, journalId: null }),
        syncJournal: async () => {},
        localRunner: () => localRunnerFor(stateRoot).session,
      });
      runtime.onEvent((_id, event) => {
        events.push(event);
      });
      const launch: RuntimeLaunch = {
        agentId,
        cwd,
        engine: testCase.engine,
        model: null,
        bins: {
          claudeBin: "/opt/golden/claude",
          codexBin: "/opt/golden/codex",
          opencodeBin: "/opt/golden/opencode",
        },
        systemPrompt: testCase.systemPrompt,
        personaContext: testCase.personaContext,
        mcp: { url: "http://127.0.0.1:1/api/mcp/agt_golden", token: "tok" },
        env: {
          RECORD_DIR: record,
          DISPATCH_LOCAL_CA_CERTIFICATE: ca,
          DISPATCH_GOLDEN_LAUNCH_VALUE: "kept",
          // The fake agent otherwise guesses its engine from the user's shell.
          FAKE_ACP_ENGINE: testCase.engine,
          ...testCase.env,
        },
        pathPrefix: ["/opt/golden/prefix-bin"],
        resumeSessionId: null,
      };
      await runtime.launch(launch);
      try {
        await runtime.prompt(agentId, "first prompt ✓", SOURCE).settled;
        await runtime.prompt(agentId, "second prompt").settled;
        await until(
          () =>
            events.filter(
              (event) => event.type === "turn" && event.state === "settled"
            ).length === 2
        );
      } finally {
        await runtime.stop(agentId);
      }

      const dir = path.join(stateRoot, agentId);
      const normalize = (value: unknown): unknown =>
        JSON.parse(
          JSON.stringify(value)
            .split(dir)
            .join("<state>")
            .split(record)
            .join("<record>")
            .split(cwd)
            .join("<cwd>")
            .split(ca)
            .join("<ca>")
            .split(recorder)
            .join("<recorder>")
            .split(repoRoot)
            .join("<repo>")
            .replace(
              /fake_(claude|codex|opencode)_[A-Za-z0-9_-]+/g,
              "fake_$1_<id>"
            )
            .replace(
              /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
              "<uuid>"
            )
        );

      const adapter = JSON.parse(
        readFileSync(path.join(record, "adapter.json"), "utf8")
      ) as { argv: string[]; env: Record<string, string> };
      const caFiles: Record<string, unknown> = {};
      for (const key of CA_ENV) {
        const file = adapter.env[key];
        if (!file) continue;
        const text = readFileSync(file, "utf8");
        caFiles[key] = {
          file: normalize(file),
          // The host's runtime holds its own public roots; count, don't compare.
          withPublicRoots: text.split("BEGIN CERTIFICATE").length > 100,
          endsWithLocalCa: text.endsWith(readFileSync(ca, "utf8")),
        };
      }
      const pathEntries = (adapter.env.PATH ?? "").split(path.delimiter);
      const lines = readFileSync(path.join(record, "stdin.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      // What the host asked the engine, in order. Answers to the engine's own
      // requests carry nothing the launch chose.
      const requests = lines.filter((line) => "method" in line);

      const files = readdirSync(dir).sort();
      const contents: Record<string, unknown> = {};
      for (const name of [
        HOST_FILES.launch,
        HOST_FILES.personaContext,
        HOST_FILES.instructions,
      ]) {
        const file = path.join(dir, name);
        if (!existsSync(file)) continue;
        const text = readFileSync(file, "utf8");
        contents[name] = name === HOST_FILES.launch ? JSON.parse(text) : text;
      }
      const turnStarts = events.flatMap((event) =>
        event.type === "turn" && event.state === "started"
          ? [{ text: event.text, source: event.source ?? null }]
          : []
      );

      expectGolden(
        testCase.engine,
        normalize({
          adapter: {
            argv: adapter.argv,
            env: Object.fromEntries(
              [...COMMON_ENV, ...ENGINE_ENV[testCase.engine]].map((key) => [
                key,
                adapter.env[key] ?? null,
              ])
            ),
            ca: caFiles,
            pathHead: pathEntries.slice(0, 1),
            pathHasEngineDir: pathEntries.includes("/opt/golden"),
          },
          requests,
          turnStarts,
          files,
          contents,
        })
      );
    }, 60_000);
  }

  it("keeps every host-file name", () => {
    expectGolden("files", HOST_FILES);
  });
});
