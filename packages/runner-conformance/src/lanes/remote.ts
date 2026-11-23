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
  RunnerCallError,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import { acceptRemoteRunner } from "../reference-client.js";
import { LaneUnavailable, type Lane } from "../run.js";
import { launchRequest } from "../session.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const IMAGE = process.env.RUNNER_CONFORMANCE_IMAGE ?? "node:22-bookworm";
const WORKSPACE = "conformance";
const WORKSPACE_DIR = "/opt/conformance-checkout";
const UID = 1500;
const SESSION = sessionFromWire("conformance-session");

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
install -d /opt/profile-tools
cat > /etc/profile.d/conformance.sh <<'PROFILE'
export PATH="/opt/profile-tools:$PATH"
PROFILE
cat > /opt/profile-tools/fixture-checkout <<'TOOL'
#!/bin/sh
printf '%s:%s' "$(id -u)" "$FIXTURE_VALUE"
TOOL
chmod 755 /opt/profile-tools/fixture-checkout
setpriv --reuid=${UID} --regid=${UID} --clear-groups git -C ${WORKSPACE_DIR} init -b main
setpriv --reuid=${UID} --regid=${UID} --clear-groups git -C ${WORKSPACE_DIR} -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -m base
printf "/file-list/\\n" >> ${WORKSPACE_DIR}/.git/info/exclude
mkdir ${WORKSPACE_DIR}/file-list
index=0
while [ "$index" -lt 1050 ]; do
  : > ${WORKSPACE_DIR}/file-list/"$index".txt
  index=$((index + 1))
done
printf private > ${WORKSPACE_DIR}/.root-only
chmod 600 ${WORKSPACE_DIR}/.root-only
printf guard > ${WORKSPACE_DIR}/.exec-probe
exec /opt/bin/runner remote-runner /run/cfg/runner.json
`;

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
    await accepted.runner.call("session.launch", launchRequest(SESSION));
    if (accepted.ready.checkoutExecStream) {
      const target = { session: SESSION, checkout: "current" } as const;
      const path = ".exec-probe";
      const exec = {
        target,
        guard: { path, digest: await accepted.readGuard(SESSION, path) },
        shell: "direct",
        env: { FIXTURE_VALUE: "literal ; $HOME" },
        timeoutMs: 15_000,
        maxOutput: null,
      } as const;
      const call = (argv: string[]) =>
        accepted.runner.call("checkout.exec", { ...exec, argv });
      const profile = await call(["fixture-checkout"]);
      if (profile.exitCode !== 0 || profile.stdout !== `${UID}:literal ; $HOME`)
        throw new Error(
          "Direct checkout exec did not use the workload login PATH and request environment."
        );
      const bytes = 33 * 1024 * 1024;
      const { stdout, stderr, exitCode, truncated } = await call([
        "/bin/sh",
        "-c",
        `head -c ${bytes} /dev/zero | tr '\\000' x; printf tail >&2`,
      ]);
      if (
        exitCode !== 0 ||
        stdout.length !== bytes ||
        stderr !== "tail" ||
        truncated !== undefined
      )
        throw new Error(
          "Checkout exec returned unexpected large-output status " +
            JSON.stringify({
              exitCode,
              stdoutLength: stdout.length,
              stderr,
              truncated,
              expectedLength: bytes,
            })
        );
      const bounded = await accepted.runner.call("checkout.exec", {
        ...exec,
        argv: ["/bin/sh", "-c", "printf 12345; printf abcde >&2"],
        maxOutput: 4,
      });
      if (
        bounded.exitCode !== 0 ||
        bounded.stdout !== "1234" ||
        bounded.stderr !== "abcd" ||
        !bounded.truncated
      )
        throw new Error(
          "Checkout exec did not honor its requested output limit."
        );
      try {
        await accepted.runner.call("checkout.exec", {
          ...exec,
          argv: ["/bin/sleep", "5"],
          timeoutMs: 30,
        });
        throw new Error("Checkout exec ignored its requested timeout.");
      } catch (error) {
        if (!(error instanceof RunnerCallError) || error.code !== "timeout")
          throw error;
      }
    }
    return {
      runner: accepted.runner,
      session: SESSION,
      readGuard: accepted.readGuard,
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
