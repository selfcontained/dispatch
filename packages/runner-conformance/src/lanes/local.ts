/*
 * Local lane: the local runner child exactly as an app starts it, through
 * its launcher pipe, reached over its local socket. Its program is the
 * server entry point's `local-runner` mode run from source, its hosts the
 * same entry point's `agent-host` mode, and its only engine the
 * deterministic ACP fixture adapter the remote lane uses.
 *
 * The lane supplies what the local runner does not resolve itself yet: a
 * session's directory (a binding prepared from the lane's checkout) and its
 * engine programs, both on the launch request, as an app does.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { superviseRunner } from "@dispatch/runner-client/launcher";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
import {
  pathFromWire,
  RunnerCallError,
  sessionFromWire,
  sessionToWire,
  type CallName,
  type CallOptions,
  type Req,
  type Res,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { checked } from "../checked.js";
import { LaneUnavailable, type Lane } from "../run.js";
import { launchRequest } from "../session.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const entry = join(root, "apps/server/src/main.ts");
const adapter = join(root, "apps/server/test/helpers/remote-acp-fixture.ts");
const SESSION = sessionFromWire("conformance-session");
const bun = process.env.BUN_BINARY ?? "bun";

/** The adapter checks that its engine CLI reports itself ready. */
const FIXTURE_ENGINE = `#!/bin/sh
case "$*" in
  --version) echo '0.0.0-fixture' ;;
  'auth status --json') echo '{"loggedIn":true}' ;;
  *) exit 64 ;;
esac
`;

const run = (command: string, args: string[]) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Processes whose command line is a host under `stateRoot`. */
function hostsUnder(stateRoot: string): number[] {
  return run("/bin/ps", ["-axo", "pid=,args="])
    .split("\n")
    .filter((line) => line.includes(`agent-host --state ${stateRoot}/`))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

export async function startLocalLane(): Promise<Lane> {
  let build: { version: string; revision?: string };
  try {
    run(bun, ["scripts/generate-server-runtime-assets.mjs"]);
    const identity = JSON.parse(
      run(bun, [entry, "runner-update-compatibility"])
    ) as { version: string; revision: string | null };
    build = {
      version: identity.version,
      ...(identity.revision && { revision: identity.revision }),
    };
  } catch (error) {
    throw new LaneUnavailable(
      `The local runner program cannot run: ${(error as Error).message}`
    );
  }

  // Short: host sockets live under the state root (macOS: 104 bytes).
  const dir = realpathSync(mkdtempSync("/tmp/rc-local-"));
  const stateRoot = join(dir, "s");
  const checkout = join(dir, "work");
  const engine = join(dir, "bin", "fixture-engine");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(dirname(engine));
  writeFileSync(engine, FIXTURE_ENGINE);
  chmodSync(engine, 0o755);
  run("git", ["init", "-q", checkout]);

  const session = new LocalRunnerSession({
    description: {
      runnerId: "local" as never,
      displayName: "Local",
      build,
      protocol: 1 as never,
      engines: [],
      capabilities: {},
    },
    retry: { initialMs: 50, maxMs: 500 },
  });
  let ready!: () => void;
  const up = new Promise<void>((resolve) => (ready = resolve));
  const supervisor = superviseRunner({
    command: [bun, entry, "local-runner"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      SHELL: process.env.SHELL,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH:
        process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
    },
    start: {
      build,
      roots: { state: stateRoot, files: join(dir, "files") },
      config: {
        runnerId: "local",
        displayName: "Local",
        engines: [],
        hostCommand: [bun, entry, "agent-host"],
      },
    },
    backoff: { initialMs: 100, maxMs: 1_000 },
    onState(state) {
      if (state.state === "ready") {
        session.setEndpoint({
          socket: state.runner.ready.socket,
          nonce: state.runner.ready.nonce,
        });
        ready();
      } else if (state.state !== "starting") session.setEndpoint(null);
    },
  });
  const close = async () => {
    session.close();
    await supervisor.stop(3_000).catch(() => {});
    // A host a failed scenario left running was started by this lane.
    for (const pid of hostsUnder(stateRoot))
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await Promise.race([
      up,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("The local runner was not ready in 30 s.")),
          30_000
        )
      ),
    ]);
  } catch (error) {
    await close();
    throw new LaneUnavailable((error as Error).message);
  }

  /** Bind a session to the lane's checkout before its first launch. */
  const bound = new Set<string>();
  async function bind(target: Req<"session.launch">["session"]) {
    const key = sessionToWire(target);
    if (bound.has(key)) return;
    try {
      await session.call("workspace.describe", { session: target });
    } catch (error) {
      if (!(error instanceof RunnerCallError) || error.code !== "not_found")
        throw error;
      await session.call("workspace.prepare", {
        session: target,
        source: { directory: pathFromWire(checkout) },
        copyIgnored: [],
        installDependencies: false,
      });
    }
    bound.add(key);
  }

  const runner: Runner = {
    connection: session.connection,
    describe: () => session.describe(),
    open: (op, request, options) => session.open(op, request, options),
    async call<K extends CallName>(
      op: K,
      request: Req<K>,
      options?: CallOptions<K>
    ): Promise<Res<K>> {
      if (op !== "session.launch") return session.call(op, request, options);
      const launch = request as Req<"session.launch">;
      await bind(launch.session);
      return session.call(
        "session.launch",
        {
          ...launch,
          programs: launch.programs ?? {
            claude: { path: engine },
            codex: null,
            adapter: { path: bun, args: [adapter] },
          },
          pathPrefix: launch.pathPrefix ?? [],
        },
        options as CallOptions<"session.launch">
      ) as Promise<Res<K>>;
    },
  };

  try {
    await checked(runner).call("session.launch", launchRequest(SESSION));
  } catch (error) {
    await close();
    throw new LaneUnavailable(
      `The fixture session did not launch: ${(error as Error).message}`
    );
  }
  return {
    runner,
    session: SESSION,
    // Command guards bind the digest to the checkout and its root, as the
    // remote lane's v1 guards do.
    async readGuard(_session, path) {
      const content = readFileSync(join(checkout, path), "utf8");
      return createHash("sha256")
        .update(JSON.stringify(["current", checkout, checkout, path, content]))
        .digest("hex");
    },
    async seed(path, content) {
      const file = join(checkout, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    },
    close,
  };
}
