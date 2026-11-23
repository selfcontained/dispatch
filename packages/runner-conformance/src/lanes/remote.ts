/*
 * Remote lane: the compiled runner program on Linux in a Docker container,
 * with real TLS, the privilege-separated workload account and the v1 wire.
 * Its only engine is the deterministic ACP fixture adapter. Everything it
 * creates is labelled with the run id and removed on close.
 *
 * Needs: a reachable Docker daemon, `bun`, `openssl`, and the
 * `node:22-bookworm` image (or RUNNER_CONFORMANCE_IMAGE). Set
 * RUNNER_CONFORMANCE_BINARY to reuse an already compiled Linux runner.
 * Run directories go under RUNNER_CONFORMANCE_ROOT (default
 * ~/.cache/runner-conformance), which the Docker VM must share: Colima does
 * not share the system temporary directory.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sessionFromWire,
  type Runner,
} from "@dispatch/runner-protocol/contract";
import { acceptRemoteRunner } from "../reference-client.js";
import { LaneUnavailable, type Lane } from "../run.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const IMAGE = process.env.RUNNER_CONFORMANCE_IMAGE ?? "node:22-bookworm";
const WORKSPACE = "conformance";
const WORKSPACE_DIR = "/opt/conformance-checkout";
const UID = 1500;
/** The scenarios' session, and a second one for the reference client. */
export const REMOTE_SESSIONS = ["conformance-session", "reference-session"];

const run = (command: string, args: string[], input?: string) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });

function dockerArch(): "arm64" | "x64" {
  try {
    return run("docker", ["version", "--format", "{{.Server.Arch}}"]).trim() ===
      "arm64"
      ? "arm64"
      : "x64";
  } catch {
    throw new LaneUnavailable("Docker is not reachable.");
  }
}

/** Today's runner is the server entry point compiled for Linux; the adapter is the e2e fixture. */
function compile(dir: string, arch: "arm64" | "x64") {
  const build = (entry: string, outfile: string) =>
    run("bun", [
      "build",
      "--compile",
      `--target=bun-linux-${arch}`,
      entry,
      "--outfile",
      outfile,
    ]);
  const adapter = join(dir, "acp-fixture");
  build("apps/server/test/helpers/remote-acp-fixture.ts", adapter);
  const prebuilt = process.env.RUNNER_CONFORMANCE_BINARY;
  if (prebuilt) return { runner: prebuilt, adapter };
  const runner = join(dir, "runner");
  run("bun", ["scripts/generate-server-runtime-assets.mjs"]);
  build("apps/server/src/main.ts", runner);
  return { runner, adapter };
}

/** A throwaway CA, a service certificate for the container's host name and a runner certificate. */
function certificates(dir: string) {
  const ssl = (...args: string[]) => run("openssl", args);
  const file = (name: string) => join(dir, name);
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"];
  ssl(
    "req",
    "-x509",
    ...ec,
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=conformance-ca",
    "-keyout",
    file("ca.key"),
    "-out",
    file("ca.pem")
  );
  for (const [name, extension] of [
    ["service", "subjectAltName=DNS:host.docker.internal,IP:127.0.0.1"],
    ["runner", "extendedKeyUsage=clientAuth"],
  ]) {
    ssl(
      "req",
      ...ec,
      "-nodes",
      "-subj",
      `/CN=${name}`,
      "-keyout",
      file(`${name}.key`),
      "-out",
      file(`${name}.csr`)
    );
    writeFileSync(file(`${name}.ext`), extension + "\n");
    ssl(
      "x509",
      "-req",
      "-in",
      file(`${name}.csr`),
      "-CA",
      file("ca.pem"),
      "-CAkey",
      file("ca.key"),
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      file(`${name}.ext`),
      "-out",
      file(`${name}.pem`)
    );
  }
  // Read by root in the container from a read-only mount of this directory.
  chmodSync(file("runner.key"), 0o644);
  return {
    key: readFileSync(file("service.key"), "utf8"),
    cert: readFileSync(file("service.pem"), "utf8"),
    ca: readFileSync(file("ca.pem"), "utf8"),
  };
}

/** The adapter checks that its engine CLI reports itself ready. */
const FIXTURE_ENGINE = `#!/bin/sh
case "$*" in
  --version) echo '0.0.0-fixture' ;;
  'auth status --json') echo '{"loggedIn":true}' ;;
  *) exit 64 ;;
esac
`;

const ENTRYPOINT = `#!/bin/sh
set -eu
getent passwd ${UID} >/dev/null || useradd -u ${UID} -m -d /home/workload workload
install -d -m 700 /run/cfg /var/lib/runner
install -d -o ${UID} -g ${UID} -m 755 ${WORKSPACE_DIR}
install -m 755 /etc/runner/fixture-engine /usr/local/bin/fixture-engine
install -m 600 /etc/runner/runner.json /run/cfg/runner.json
exec /opt/bin/runner remote-runner /run/cfg/runner.json
`;

/** v1 binds a session to its workspace when it launches. */
async function launch(runner: Runner, session: string) {
  await runner.call("session.launch", {
    session: sessionFromWire(session),
    launchId: randomUUID(),
    engine: "claude",
    model: null,
    effort: null,
    access: "default",
    resume: null,
    systemText: null,
    firstText: null,
    overflowNotice: null,
    env: {},
    mcp: [],
    owner: null,
  });
}

export async function startRemoteLane(): Promise<Lane> {
  const arch = dockerArch();
  const base =
    process.env.RUNNER_CONFORMANCE_ROOT ??
    join(homedir(), ".cache", "runner-conformance");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(base, "run-"));
  const id = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  const container = `runner-conformance-${id}`;
  const config = join(dir, "config");
  mkdirSync(config);
  let listener: ReturnType<typeof acceptRemoteRunner> | undefined;
  const cleanup = () => {
    try {
      run("docker", ["rm", "-f", container]);
    } catch {
      // Never started.
    }
    listener?.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const binary = compile(dir, arch);
    const credentials = certificates(config);
    listener = acceptRemoteRunner(credentials, {
      runnerId: id,
      workspace: WORKSPACE,
    });
    const port = await listener.port;
    writeFileSync(
      join(config, "runner.json"),
      JSON.stringify({
        endpoint: `https://host.docker.internal:${port}`,
        ca: "/etc/runner/ca.pem",
        cert: "/etc/runner/runner.pem",
        key: "/etc/runner/runner.key",
        state: "/var/lib/runner",
        uid: UID,
        gid: UID,
        home: "/home/workload",
        path: "/usr/local/bin:/usr/bin:/bin",
        bins: { claudeBin: "/usr/local/bin/fixture-engine", codexBin: null },
        adapter: ["/opt/bin/acp-fixture"],
        workspaces: { [WORKSPACE]: { cwd: WORKSPACE_DIR } },
      })
    );
    writeFileSync(join(config, "fixture-engine"), FIXTURE_ENGINE);
    writeFileSync(join(config, "entrypoint.sh"), ENTRYPOINT);
    run("docker", [
      "run",
      "-d",
      "--name",
      container,
      "--label",
      `runner-conformance=${id}`,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-v",
      `${config}:/etc/runner:ro`,
      "-v",
      `${binary.runner}:/opt/bin/runner:ro`,
      "-v",
      `${binary.adapter}:/opt/bin/acp-fixture:ro`,
      "--entrypoint",
      "/bin/sh",
      IMAGE,
      "/etc/runner/entrypoint.sh",
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        let logs = "";
        try {
          logs = run("docker", ["logs", "--tail", "20", container]);
        } catch {
          // The container is gone.
        }
        reject(new Error(`The runner did not connect within 60 s.\n${logs}`));
      }, 60_000);
    });
    const accepted = await Promise.race([listener.accepted, timeout]).finally(
      () => clearTimeout(timer)
    );
    for (const session of REMOTE_SESSIONS)
      await launch(accepted.runner, session);
    return {
      runner: accepted.runner,
      session: sessionFromWire(REMOTE_SESSIONS[0]!),
      async seed(path, content) {
        run(
          "docker",
          [
            "exec",
            "-i",
            "-u",
            String(UID),
            "-w",
            WORKSPACE_DIR,
            container,
            "sh",
            "-c",
            'mkdir -p "$(dirname "$1")" && cat > "$1"',
            "sh",
            path,
          ],
          content
        );
      },
      async close() {
        accepted.close();
        cleanup();
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
