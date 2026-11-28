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
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { superviseRunner } from "@dispatch/runner-client/launcher";
import { LocalRunnerSession } from "@dispatch/runner-client/session";
import {
  displayPath,
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
  const selectionDirectory = join(dir, "other");
  mkdirSync(selectionDirectory);
  mkdirSync(dirname(engine));
  writeFileSync(engine, FIXTURE_ENGINE);
  chmodSync(engine, 0o755);
  run("git", ["init", "-q", "-b", "main", checkout]);
  writeFileSync(
    join(checkout, "package.json"),
    JSON.stringify({
      name: "runner-fixture",
      version: "1.0.0",
      scripts: { postinstall: "id -u > .install-uid" },
    })
  );
  writeFileSync(
    join(checkout, "package-lock.json"),
    JSON.stringify({
      name: "runner-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "runner-fixture",
          version: "1.0.0",
          hasInstallScript: true,
        },
      },
    })
  );
  run("git", ["-C", checkout, "add", "package.json", "package-lock.json"]);
  run("git", [
    "-C",
    checkout,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "base",
  ]);
  mkdirSync(join(checkout, "file-list"));
  for (let i = 0; i < 1050; i++)
    writeFileSync(join(checkout, "file-list", `${i}.txt`), "");
  writeFileSync(
    join(checkout, ".git/info/exclude"),
    "/file-list/\n/conformance/\n"
  );

  const repository = join(dir, "origin.git");
  run("git", ["clone", "-q", "--bare", checkout, repository]);
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
      DISPATCH_LOCAL_RUNNER_LAUNCH: JSON.stringify({
        filesRoot: join(dir, "files"),
        helperBin: bun,
        env: {},
        bins: {
          claudeBin: engine,
          codexBin: engine,
          opencodeBin: engine,
          adapter: { bin: bun, args: [adapter] },
        },
      }),
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
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      up,
      new Promise((_, reject) => {
        readyTimer = setTimeout(
          () => reject(new Error("The local runner was not ready in 30 s.")),
          30_000
        );
      }),
    ]);
  } catch (error) {
    await close();
    throw new LaneUnavailable((error as Error).message);
  } finally {
    clearTimeout(readyTimer);
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
    workspace: {
      runner: checked(runner),
      repository: `file://${repository}`,
      selectionDirectory,
      configuredResume: "empty",
      async interrupt(target) {
        const key = sessionToWire(target);
        const receipt = join(stateRoot, key, "workspace-preparation");
        const state = JSON.parse(readFileSync(receipt, "utf8"));
        state.pending = {
          path: state.worktree.path,
          branch: state.worktree.branch,
        };
        delete state.worktree;
        writeFileSync(receipt, JSON.stringify(state));
        rmSync(
          join(
            stateRoot,
            ".bindings",
            createHash("sha256").update(key).digest("hex") + ".json"
          )
        );
      },
      async proveIsolation(target, path) {
        const binding = await runner.call("workspace.describe", {
          session: target,
        });
        if (
          displayPath(binding.path) !== path ||
          statSync(path).uid !== process.getuid?.()
        )
          throw new Error(
            "Managed checkout is not owned by the local workload account."
          );
        if (
          readFileSync(join(path, ".install-uid"), "utf8").trim() !==
          String(process.getuid?.())
        )
          throw new Error(
            "Dependencies did not run as the local workload account."
          );
        await runner.call("session.discard", { session: target });
        if (existsSync(path))
          throw new Error("Discard retained the managed checkout.");
      },
      async proveRelease(external, externalSession) {
        if (
          (
            await external.call("workspace.release", {
              session: externalSession,
              deleteBranch: true,
              originalBranch: "main",
            })
          ).removed
        )
          throw new Error("Release accepted an external checkout.");
        const target = sessionFromWire("release-owner");
        const made = await runner.call("workspace.prepare", {
          session: target,
          source: {
            repository: `file://${repository}`,
            checkout: { kind: "new", branch: "release-original" },
          },
          copyIgnored: [],
          installDependencies: false,
        });
        const release = () =>
          runner.call("workspace.release", {
            session: target,
            deleteBranch: true,
            originalBranch: "release-original",
          });
        const own = displayPath(made.path);
        // Replacing the owned path must never authorize removing an external checkout.
        renameSync(own, own + "-saved");
        symlinkSync(checkout, own);
        try {
          const refused = await release().catch((error: unknown) => {
            if (!(error instanceof RunnerCallError)) throw error;
            return null;
          });
          if (
            refused?.removed ||
            !existsSync(checkout) ||
            !existsSync(own + "-saved/.git")
          )
            throw new Error("Release accepted a replaced checkout.");
        } finally {
          unlinkSync(own);
          renameSync(own + "-saved", own);
        }
        const git = (...args: string[]) =>
          run("git", ["-C", own, ...args]).trim();
        const common = git("rev-parse", "--git-common-dir");
        const branches = () =>
          run("git", [
            "--git-dir",
            common,
            "branch",
            "--format=%(refname:short)",
          ]).split("\n");
        git("branch", "--set-upstream-to=origin/main", "release-original");
        git("switch", "-c", "release-current");
        git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "unmerged"
        );
        if (!(await release()).removed || existsSync(displayPath(made.path)))
          throw new Error("Owned checkout was not released.");
        if (!(await release()).removed)
          throw new Error("Repeated release was not idempotent.");
        if (
          branches().includes("release-current") ||
          branches().includes("release-original")
        )
          throw new Error(
            "Release retained current or fully merged original branch."
          );
        for (const ahead of [false, true]) {
          const session = sessionFromWire(`release-retain-${ahead}`);
          const branch = `retain-original-${ahead}`;
          const retained = await runner.call("workspace.prepare", {
            session,
            source: {
              repository: `file://${repository}`,
              checkout: { kind: "new", branch },
            },
            copyIgnored: [],
            installDependencies: false,
          });
          const gitRetained = (...args: string[]) =>
            run("git", ["-C", displayPath(retained.path), ...args]);
          if (ahead) {
            gitRetained("branch", "--set-upstream-to=origin/main", branch);
            gitRetained(
              "-c",
              "user.name=Fixture",
              "-c",
              "user.email=fixture@example.invalid",
              "commit",
              "--allow-empty",
              "-m",
              "ahead"
            );
          } else {
            // Explicitly remove any implicit tracking inherited from the start point.
            try {
              gitRetained("branch", "--unset-upstream", branch);
            } catch {
              /* no upstream */
            }
          }
          gitRetained("switch", "-c", `retain-current-${ahead}`);
          if (
            !(
              await runner.call("workspace.release", {
                session,
                deleteBranch: true,
                originalBranch: branch,
              })
            ).removed ||
            !branches().includes(branch)
          )
            throw new Error(
              "Release deleted an original branch without a fully merged upstream."
            );
        }
        const missingSession = sessionFromWire("release-missing");
        const missing = await runner.call("workspace.prepare", {
          session: missingSession,
          source: {
            repository: `file://${repository}`,
            checkout: { kind: "new", branch: "release-missing" },
          },
          copyIgnored: [],
          installDependencies: false,
        });
        rmSync(displayPath(missing.path), { recursive: true, force: true });
        if (
          !(
            await runner.call("workspace.release", {
              session: missingSession,
              deleteBranch: false,
              originalBranch: "release-missing",
            })
          ).removed ||
          !branches().includes("release-missing")
        )
          throw new Error(
            "Missing checkout release did not preserve deleteBranch=false."
          );
        const remaining = run("git", [
          "--git-dir",
          repository,
          "branch",
          "--format=%(refname:short)",
        ]);
        // The cache owns the working branches; the bare origin must remain untouched.
        if (!remaining.split("\n").includes("main"))
          throw new Error("Release changed the source repository.");
        if (!existsSync(checkout))
          throw new Error("Release removed the external checkout.");
      },
    },
    async seed(path, content) {
      const file = join(checkout, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    },
    close,
  };
}
