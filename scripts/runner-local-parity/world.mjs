// One isolated Dispatch: database, home, state root, port and processes.
// Nothing here may reach a real install, engine, account or the network.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import { dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { childProcessEnv } from "../../apps/server/src/shared/process/child-environment.js";
import {
  killOwnedProcesses,
  ownedEnvironment,
} from "../../apps/server/src/shared/process/owned-processes.js";
import { repository, run } from "./build.mjs";

const require = createRequire(join(repository, "apps/server/package.json"));
const pg = require("pg");

// Installed and staging instances. Their ports are never bound or contacted.
const FORBIDDEN_PORTS = new Set([6767, 6768, 51833, 51834, 51839, 62699]);
const reservedPorts = new Set();
const HEADERS = [
  "cache-control",
  "content-disposition",
  "content-security-policy",
  "content-type",
  "x-content-type-options",
];
const FIXED_DATE = "2026-01-02T03:04:05Z";
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

/** A scenario that cannot go on. Reported as a failure, never as a difference. */
export class HarnessError extends Error {}

/**
 * Below the ephemeral range. A server keeps its port across restarts, and an
 * outgoing connection must not be able to take it in the gap.
 */
async function freePort() {
  for (;;) {
    const port = randomInt(20_000, 32_000);
    if (FORBIDDEN_PORTS.has(port) || reservedPorts.has(port)) continue;
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (!free) continue;
    reservedPorts.add(port);
    return port;
  }
}

function executable(file, body) {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

/**
 * Two timing edits to the copy of the fixture, so that nothing timing-related
 * has to be normalised away. The fixture answers session/new in microseconds,
 * which no engine does:
 * - On main as on the head, the first config report is sometimes never
 *   recorded (the agent's model stays null) when it lands while the server is
 *   still attaching. The pause lets attach finish, as a real engine would.
 * - Commands are announced on a zero timer, racing the session/new reply.
 *   A later announcement gives the journal one order.
 */
function steadyFixture(file) {
  let source = readFileSync(file, "utf8");
  const replace = (pattern, replacement) => {
    const next = source.replace(pattern, replacement);
    if (next === source)
      throw new Error("The ACP fixture changed under the parity oracle");
    source = next;
  };
  replace(
    /async (newSession|resumeSession)\(params\) \{/g,
    "$&\n    await new Promise((resolve) => setTimeout(resolve, 700));"
  );
  replace(/(availableCommands:[\s\S]*?\n {4}\}, )0\);/, "$1250);");
  writeFileSync(file, source);
}

/**
 * What every world shares: command shims and the deterministic ACP adapter.
 * The adapter is copied under the run root so its processes are recognisable.
 */
export function prepareTools(root) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  // These would reach the operator's accounts, clipboard, services or paid
  // engines. Found first on PATH, they refuse, and say so in shim.log.
  for (const name of [
    "claude",
    "codex",
    "curl",
    "gh",
    "launchctl",
    "npm",
    "npx",
    "open",
    "opencode",
    "osascript",
    "pbcopy",
    "security",
    "systemctl",
    "systemd-run",
    "xclip",
  ])
    executable(
      join(bin, name),
      `#!/bin/sh\n[ "$1" = "--version" ] && { echo "0.0.0-parity"; exit 0; }\n[ -n "$PARITY_SHIM_LOG" ] && echo "${name}" >> "$PARITY_SHIM_LOG"\necho "${name} is unavailable in the parity oracle" >&2\nexit 64\n`
    );

  const fixtures = join(root, "fixture/e2e/fixtures");
  const server = join(root, "fixture/apps/server");
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(server, { recursive: true });
  for (const name of [
    "fake-acp-agent.mjs",
    "fake-engine-cli.sh",
    "runner-file-transfer.mjs",
  ]) {
    copyFileSync(join(repository, "e2e/fixtures", name), join(fixtures, name));
    chmodSync(join(fixtures, name), 0o755);
  }
  writeFileSync(join(server, "package.json"), '{"type":"module"}\n');
  symlinkSync(
    join(repository, "apps/server/node_modules"),
    join(server, "node_modules")
  );
  steadyFixture(join(fixtures, "fake-acp-agent.mjs"));
  // The real binary. On macOS /usr/bin/git is xcrun's shim, which takes about
  // 100ms per call with a fresh HOME and TMPDIR, and main gives Git probes 800ms.
  const execPath = execFileSync("git", ["--exec-path"], {
    encoding: "utf8",
    env: childProcessEnv(),
  }).trim();
  const realGit = realpathSync(join(execPath, "git"));
  symlinkSync(realGit, join(bin, "git"));
  return { root, bin, fixtures, realGit };
}

export function processesUnder(root) {
  const output = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: childProcessEnv(),
  });
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    return match && match[2].includes(root) && Number(match[1]) !== process.pid
      ? [Number(match[1])]
      : [];
  });
}

/** By PID, only for processes carrying a path this run created with mkdtemp. */
export function killUnder(root) {
  for (const pid of processesUnder(root)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class World {
  /**
   * `side` decides which build is "the build under test" (`this.side`).
   * Upgrade scenarios start or finish on main whichever side they are, so
   * main's column is always main to main.
   */
  constructor({ side, directory, database, adminUrl, tools, builds }) {
    Object.assign(this, { side, database, adminUrl, tools, builds });
    this.root = directory;
    this.observed = {};
    this.agents = [];
    this.secrets = new Set();
    this.child = null;
    this.port = null;
    this.ownership = ownedEnvironment({});
    this.paths = Object.fromEntries(
      ["home", "tmp", "state", "work", "bin"].map((name) => [
        name,
        join(directory, name),
      ])
    );
    this.paths.files = join(this.paths.state, "files");
    this.paths.agents = join(this.paths.state, "agents");
    this.runtime = join(directory, "dispatch");
    this.log = join(directory, "server.log");
    this.shimLog = join(directory, "shim.log");
  }

  assertLive() {
    if (this.disposal) throw new HarnessError("The run is shutting down");
  }

  async prepare() {
    this.assertLive();
    for (const directory of Object.values(this.paths))
      mkdirSync(directory, { recursive: true });
    this.searchPath = [
      this.paths.bin,
      this.tools.bin,
      dirname(process.execPath),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":");
    const dotDispatch = join(this.paths.home, ".dispatch");
    mkdirSync(dotDispatch);
    // A login shell rebuilds PATH from /etc/profile. Put the shims back first.
    writeFileSync(
      join(dotDispatch, "env"),
      `export PATH='${this.searchPath}'\n`
    );
    writeFileSync(
      join(this.paths.home, ".gitconfig"),
      "[user]\n\tname = Parity Fixture\n\temail = parity@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n"
    );
    // Kept, so that a teardown which starts meanwhile still drops it.
    this.creating = this.admin(
      `CREATE DATABASE "${this.database}" TEMPLATE template0`
    ).then(() => {
      this.databaseCreated = true;
    });
    await this.creating;
    this.assertLive();
    const url = new URL(this.adminUrl);
    url.pathname = `/${this.database}`;
    this.databaseUrl = url.toString();
    this.secrets.add(this.databaseUrl);
    this.pool = new pg.Pool({ connectionString: this.databaseUrl, max: 3 });
    // A forced drop at teardown ends idle connections.
    this.pool.on("error", () => {});
    this.port = await freePort();
  }

  async admin(statement) {
    const client = new pg.Client({ connectionString: this.adminUrl });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  }

  async sql(query, values = []) {
    return (await this.pool.query(query, values)).rows;
  }

  environment(extra = {}) {
    // An allowlist. Nothing from the calling agent or shell is inherited.
    return {
      ...this.ownership.env,
      HOME: this.paths.home,
      CFFIXED_USER_HOME: this.paths.home,
      TMPDIR: this.paths.tmp,
      PATH: this.searchPath,
      SHELL: "/bin/sh",
      USER: "parity",
      LOGNAME: "parity",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      NODE_ENV: "production",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      // No egress: anything that is not loopback meets a closed port.
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
      PARITY_SHIM_LOG: this.shimLog,
      DATABASE_URL: this.databaseUrl,
      DISPATCH_HOST: "127.0.0.1",
      DISPATCH_PORT: String(this.port),
      DISPATCH_STATE_DIR: this.paths.state,
      DISPATCH_FILES_ROOT: this.paths.files,
      DISPATCH_AGENT_STATE_ROOT: this.paths.agents,
      DISPATCH_RELEASE_STORE_PATH: join(this.paths.state, "release.json"),
      DISPATCH_RELEASE_CANDIDATE_STORE_PATH: join(
        this.paths.state,
        "release-candidate.json"
      ),
      DISPATCH_SERVER_DIR: join(this.paths.state, "server"),
      DISPATCH_INSTANCE_ID: "parity-instance",
      DISPATCH_AGENT_RUNTIME: "acp",
      DISPATCH_ACP_ADAPTER_COMMAND: JSON.stringify([
        process.execPath,
        join(this.tools.fixtures, "fake-acp-agent.mjs"),
      ]),
      DISPATCH_CLAUDE_BIN: join(this.tools.fixtures, "fake-engine-cli.sh"),
      DISPATCH_CODEX_BIN: join(this.tools.fixtures, "fake-engine-cli.sh"),
      DISPATCH_OPENCODE_BIN: join(this.tools.fixtures, "fake-engine-cli.sh"),
      ...extra,
    };
  }

  /** Put a build at the one runtime path, as an installer does. */
  install(which) {
    const temporary = `${this.runtime}.next`;
    rmSync(temporary, { force: true });
    linkSync(this.builds[which].binary, temporary);
    renameSync(temporary, this.runtime);
  }

  async start(which = this.side, env = {}) {
    this.assertLive();
    if (this.child) throw new HarnessError("The server is already running");
    this.install(which);
    const offset = lstatSync(this.log, { throwIfNoEntry: false })?.size ?? 0;
    const output = openSync(this.log, "a");
    const child = spawn(this.runtime, [], {
      cwd: this.root,
      env: this.environment(env),
      stdio: ["ignore", output, output],
    });
    closeSync(output);
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve(code ?? signal));
      child.once("error", () => resolve("spawn failed"));
    });
    const listening = `Dispatch listening on http://127.0.0.1:${this.port}`;
    const deadline = Date.now() + 45_000;
    for (;;) {
      // Contact the port only after this very process says it owns it.
      const log = readFileSync(this.log).subarray(offset).toString("utf8");
      if (log.includes(listening)) break;
      if (child.exitCode !== null || child.signalCode || Date.now() > deadline)
        throw new HarnessError(
          `The ${which} build did not start:\n${this.redact(log.slice(-3000))}`
        );
      await sleep(50);
    }
    const [row] = await this.sql(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    this.token = row.value;
    this.secrets.add(this.token);
    // Offline anyway. This keeps the release check's failure out of the logs.
    if (!env.DISPATCH_RECOVERY_PROBATION)
      await this.sql(
        "INSERT INTO settings (key, value) VALUES ('automatic_update_mode', 'off') ON CONFLICT (key) DO NOTHING"
      );
  }

  async stop() {
    if (!this.child) return null;
    const { child } = this;
    if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
    const result = await Promise.race([
      this.exited,
      sleep(20_000, "timeout", { ref: false }),
    ]);
    if (result === "timeout") {
      child.kill("SIGKILL");
      await this.exited;
    }
    this.child = null;
    return result;
  }

  /** The server exits by itself, as at the end of a fence. */
  async waitForExit(timeout = 30_000) {
    const result = await Promise.race([
      this.exited,
      sleep(timeout, "still running", { ref: false }),
    ]);
    if (result !== "still running") this.child = null;
    return result;
  }

  async restart(which = this.side) {
    await this.stop();
    await this.start(which);
  }

  redact(text) {
    let value = text;
    for (const secret of this.secrets)
      if (secret) value = value.replaceAll(secret, "<secret>");
    return value.replace(/postgres(?:ql)?:\/\/\S+/g, "<database>");
  }

  // node:http rather than fetch: fetch gives up on a response after 300
  // seconds, and that is the very limit one scenario measures.
  request(method, path, options = {}) {
    let { body } = options;
    const headers = { ...options.headers };
    if (options.auth !== false && !headers.authorization)
      headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined && !Buffer.isBuffer(body)) {
      body = Buffer.from(JSON.stringify(body));
      headers["content-type"] = "application/json";
    }
    if (body !== undefined) headers["content-length"] = body.length;
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: this.port,
          method,
          path,
          headers,
          agent: false,
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", (error) =>
            resolve({ transportError: error.code ?? error.message })
          );
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              bytes: Buffer.concat(chunks),
            })
          );
        }
      );
      const timer = setTimeout(() => {
        request.destroy();
        resolve({ transportError: "client timeout" });
      }, options.timeout ?? 45_000);
      const abort = options.abortAfterMs
        ? setTimeout(() => {
            request.destroy();
            resolve({ transportError: "client aborted" });
          }, options.abortAfterMs)
        : undefined;
      request.on("close", () => {
        clearTimeout(timer);
        clearTimeout(abort);
      });
      request.on("error", (error) =>
        options.strict
          ? reject(error)
          : resolve({ transportError: error.code ?? error.message })
      );
      request.end(body);
    });
  }

  /** A response as compared: status, the headers that matter, and the body. */
  async api(method, path, body, options = {}) {
    const response = await this.request(method, path, { ...options, body });
    if (response.transportError) return response;
    const type = response.headers["content-type"] ?? "";
    let value;
    if (response.bytes.length === 0) value = null;
    else if (type.includes("json"))
      value = parseJson(response.bytes.toString());
    else if (type.startsWith("text/")) value = response.bytes.toString();
    else value = { bytes: response.bytes.length, sha: sha256(response.bytes) };
    return {
      status: response.status,
      headers: Object.fromEntries(
        HEADERS.filter((name) => response.headers[name] !== undefined).map(
          (name) => [name, response.headers[name]]
        )
      ),
      body: value,
    };
  }

  async upload(path, { file, field = "file", fields = {} }) {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    form.set(field, new Blob([file.bytes], { type: file.type }), file.name);
    const encoded = new Response(form);
    return this.api("POST", path, Buffer.from(await encoded.arrayBuffer()), {
      headers: { "content-type": encoded.headers.get("content-type") },
    });
  }

  async poll(check, what, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline)
        throw new HarnessError(`Timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  /** The create response, plus the agent once its launch has settled. */
  async createAgent(body = {}) {
    const response = await this.api("POST", "/api/v1/agents", {
      name: `parity-${this.agents.length + 1}`,
      type: "codex",
      cwd: this.paths.work,
      useWorktree: false,
      ...body,
    });
    const id = response.body?.agent?.id;
    if (!id) return { response };
    this.agents.push(id);
    const status = await this.poll(async () => {
      const [row] = await this.sql("SELECT status FROM agents WHERE id = $1", [
        id,
      ]);
      return row && row.status !== "creating" && row.status;
    }, `agent launch (${id})`);
    if (status === "running") {
      // Running precedes the engine session. A turn cannot start before it.
      await this.poll(
        async () =>
          (
            await this.sql(
              "SELECT 1 FROM agents WHERE id = $1 AND cli_session_id IS NOT NULL",
              [id]
            )
          ).length,
        `engine session (${id})`
      );
      // So does the engine's first config report, which names the model.
      // A build that never records it is a difference, not a failure.
      for (let attempt = 0; attempt < 100; attempt++) {
        const [row] = await this.sql("SELECT model FROM agents WHERE id = $1", [
          id,
        ]);
        if (!row || row.model) break;
        await sleep(100);
      }
    }
    await this.quiet();
    return { id, response };
  }

  async agent(body) {
    const { id, response } = await this.createAgent(body);
    if (!id)
      throw new HarnessError(
        `Could not create an agent: ${JSON.stringify(response)}`
      );
    return id;
  }

  /** Until the database stops changing. */
  async quiet(settle = 600, timeout = 30_000) {
    let last = "";
    let since = Date.now();
    await this.poll(
      async () => {
        const [row] = await this.sql(`
          SELECT (SELECT count(*)::text || coalesce(max(updated_at)::text, '') FROM agents)
              || (SELECT count(*)::text || coalesce(max(updated_at)::text, '') FROM blocks)
              || (SELECT count(*)::text || coalesce(max(updated_at)::text, '') FROM agent_stream_events) AS signature`);
        if (row.signature !== last) {
          last = row.signature;
          since = Date.now();
        }
        return Date.now() - since >= settle;
      },
      "the database to settle",
      timeout
    );
  }

  async mcpEndpoint(id) {
    const { mcp } = JSON.parse(
      readFileSync(join(this.paths.agents, id, "launch.json"), "utf8")
    );
    const url = new URL(mcp.url);
    if (url.hostname !== "127.0.0.1" || Number(url.port) !== this.port)
      throw new HarnessError("An agent's MCP URL is outside its own instance");
    const bearer = mcp.token ?? mcp.headers?.Authorization?.slice(7);
    if (bearer) this.secrets.add(bearer);
    return { path: url.pathname, bearer };
  }

  async mcp(id, method, params, options = {}) {
    const { path, bearer } = await this.mcpEndpoint(id);
    const response = await this.request("POST", path, {
      ...options,
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "application/json, text/event-stream",
      },
      body: { jsonrpc: "2.0", id: 1, method, params },
    });
    if (response.transportError) return response;
    const text = response.bytes.toString();
    const messages = (response.headers["content-type"] ?? "").includes(
      "event-stream"
    )
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => parseJson(line.slice(6)))
      : [parseJson(text)];
    const answer = messages.find((message) => message?.id === 1) ?? messages[0];
    return { status: response.status, answer };
  }

  /** tools/list, keyed by name, so one extra tool is one difference. */
  async listTools(id) {
    const { status, answer, transportError } = await this.mcp(id, "tools/list");
    if (transportError) return { transportError };
    const list = answer?.result?.tools;
    if (!Array.isArray(list)) return { status, answer };
    return Object.fromEntries(
      list.map(({ name, ...definition }) => [name, definition])
    );
  }

  async call(id, name, args = {}, options) {
    const { status, answer, transportError } = await this.mcp(
      id,
      "tools/call",
      { name, arguments: args },
      options
    );
    if (transportError) return { transportError };
    const result = answer?.result;
    if (!result) return { status, answer };
    return {
      status,
      ...result,
      content: result.content?.map((part) =>
        typeof part.text === "string"
          ? { ...part, text: parseJson(part.text) }
          : part
      ),
    };
  }

  record(name, value) {
    if (Object.hasOwn(this.observed, name))
      throw new HarnessError(`Recorded twice: ${name}`);
    this.observed[name] = value;
  }

  path(...parts) {
    return join(this.paths.work, ...parts);
  }

  write(base, files) {
    for (const [name, content] of Object.entries(files)) {
      const file = join(base, name);
      mkdirSync(dirname(file), { recursive: true });
      if (typeof content === "string" || Buffer.isBuffer(content))
        writeFileSync(file, content);
      else if (content.link !== undefined) symlinkSync(content.link, file);
      else executable(file, content.run);
    }
  }

  async git(cwd, args, options = {}) {
    const { stdout } = await run("git", args, {
      ...options,
      cwd,
      env: {
        PATH: this.searchPath,
        HOME: this.paths.home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_DATE: FIXED_DATE,
        GIT_COMMITTER_DATE: FIXED_DATE,
        LC_ALL: "C",
        TZ: "UTC",
      },
    });
    return stdout;
  }

  /** A repository with fixed dates, so commit ids are equal on both sides. */
  async repo(name, files = {}, { origin = false } = {}) {
    const directory = this.path(name);
    mkdirSync(directory, { recursive: true });
    await this.git(directory, ["init", "--quiet", "--initial-branch=main"]);
    this.write(directory, { "README.md": "fixture\n", ...files });
    await this.git(directory, ["add", "--all"]);
    await this.git(directory, ["commit", "--quiet", "-m", "Fixture"]);
    if (origin) {
      const bare = this.path(`${name}.git`);
      await this.git(this.paths.work, [
        "init",
        "--quiet",
        "--bare",
        "--initial-branch=main",
        bare,
      ]);
      await this.git(directory, ["remote", "add", "origin", bare]);
      await this.git(directory, ["push", "--quiet", "-u", "origin", "main"]);
      await this.git(directory, ["remote", "set-head", "origin", "main"]);
    }
    return directory;
  }

  /** Keyed by ref, setting and path: one leftover branch is one difference. */
  async gitState(repo) {
    const output = async (...args) =>
      (await this.git(repo, args, { allowFailure: true })).trim();
    const pairs = (text) =>
      Object.fromEntries(
        text
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [key, ...value] = line.split(" ");
            return [key, value.join(" ")];
          })
      );
    const stanzas = (await output("worktree", "list", "--porcelain"))
      .split("\n\n")
      .filter(Boolean);
    return {
      status: (await output("status", "--porcelain=v1", "--branch")).split(
        "\n"
      ),
      refs: pairs(
        await output(
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          "refs/heads",
          "refs/remotes",
          "refs/tags"
        )
      ),
      worktrees: Object.fromEntries(
        stanzas.map((stanza) => {
          const [first, ...rest] = stanza.split("\n");
          return [first.slice("worktree ".length), rest];
        })
      ),
      branchConfig: pairs(
        await output("config", "--local", "--get-regexp", "^branch\\.")
      ),
    };
  }

  /** Paths, modes and contents. Text is normalised before it is compared. */
  tree(base) {
    const found = {};
    const visit = (directory) => {
      for (const name of readdirSync(directory).sort()) {
        if (name === ".git") continue;
        const file = join(directory, name);
        const info = lstatSync(file, { throwIfNoEntry: false });
        if (!info) continue;
        const key = relative(base, file);
        if (info.isSymbolicLink()) found[key] = { link: readlinkSync(file) };
        else if (info.isDirectory()) {
          found[`${key}/`] = { mode: info.mode & 0o777 };
          visit(file);
        } else if (!info.isFile()) found[key] = { special: true };
        else {
          const bytes = readFileSync(file);
          found[key] = {
            mode: info.mode & 0o777,
            ...(bytes.length < 256 * 1024 && !bytes.includes(0)
              ? { text: bytes.toString("utf8") }
              : { bytes: bytes.length, sha: sha256(bytes) }),
          };
        }
      }
    };
    if (lstatSync(base, { throwIfNoEntry: false })) visit(base);
    return found;
  }

  shimCalls(name) {
    if (!lstatSync(this.shimLog, { throwIfNoEntry: false })) return 0;
    return readFileSync(this.shimLog, "utf8")
      .split("\n")
      .filter((line) => line === name).length;
  }

  async bindings() {
    const realTemporary = this.root.replace(/^\/private\/tmp\//, "/tmp/");
    const revisions = Object.values(this.builds).map((build) => build.commit);
    // Every agent, including those that agents launched.
    const agents = await this.sql("SELECT id FROM agents ORDER BY created_at");
    return {
      root: [this.root, realTemporary],
      builds: [...revisions, ...revisions.map((sha) => sha.slice(0, 12))],
      secrets: [...this.secrets],
      port: this.port,
      database: this.database,
      oracle: this.tools.root,
      machine: [dirname(process.execPath), os.hostname()],
      agents: this.agents,
      launched: agents.map(({ id }) => id),
    };
  }

  /** The end of the server log, for a failed scenario. Never environments. */
  logTail() {
    try {
      return this.redact(readFileSync(this.log, "utf8").slice(-3000));
    } catch {
      return "";
    }
  }

  /** Idempotent: an interrupt and the scenario's own end can both ask. */
  dispose() {
    this.disposal ??= this.teardown();
    return this.disposal;
  }

  async teardown() {
    await this.creating?.catch(() => {});
    const problems = [];
    const attempt = async (what, action) => {
      try {
        await action();
      } catch (error) {
        problems.push(`${what}: ${this.redact(error.message)}`);
      }
    };
    await attempt("stop the server", () => this.stop());
    await attempt("stop processes", () => killUnder(`${this.root}/`));
    await attempt("stop owned processes", () =>
      killOwnedProcesses(this.ownership.marker)
    );
    await attempt("close the pool", () => this.pool?.end());
    if (this.databaseCreated)
      await attempt("drop the database", () =>
        this.admin(`DROP DATABASE IF EXISTS "${this.database}" WITH (FORCE)`)
      );
    await attempt("remove the directory", () =>
      rmSync(this.root, { recursive: true, force: true, maxRetries: 3 })
    );
    return problems;
  }
}
