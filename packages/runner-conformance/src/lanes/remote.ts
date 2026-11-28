import { MATRIX_TEXT } from "../target-matrix.js";
import { FIXTURE_GITHUB } from "./fixtures.js";
/*
 * Remote lane: the compiled runner program on Linux in a Docker container,
 * with real TLS, the privilege-separated workload account and the authenticated operation carrier.
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
import { createHash } from "node:crypto";
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
  pathFromWire,
  type Runner,
  type Req,
  sessionToWire,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import { checked } from "../checked.js";
import { acceptRemoteRunner } from "../reference-client.js";
import { LaneUnavailable, type Lane } from "../run.js";
import { launchRequest } from "../session.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const IMAGE = process.env.RUNNER_CONFORMANCE_IMAGE ?? "node:22-bookworm";
const WORKSPACE_DIR = "/opt/conformance-checkout";
const UID = 1500;
const MANAGED_STATE = "/var/lib/runner-managed";
const BARE_REMOTE = "/opt/conformance-origin.git";
const REPOSITORY_URL = "https://github.com/fixture/conformance";
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
mkdir -p /opt/conformance-only-path
cat > /opt/conformance-only-path/gh <<'FIXTURE_GH'
${FIXTURE_GITHUB}
FIXTURE_GH
chmod 755 /opt/conformance-only-path/gh
set -eu
getent passwd ${UID} >/dev/null || useradd -u ${UID} -m -d /home/workload workload
install -d -m 700 /run/cfg /var/lib/runner
install -d -o ${UID} -g ${UID} -m 755 ${WORKSPACE_DIR}
install -m 755 /etc/runner/fixture-engine /usr/local/bin/fixture-engine
install -m 600 /etc/runner/runner.json /run/cfg/runner.json
install -d /opt/profile-tools
cat > /etc/profile.d/conformance.sh <<'PROFILE'
export PATH="/opt/profile-tools:$PATH"
export NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false NPM_CONFIG_UPDATE_NOTIFIER=false
PROFILE
cat > /opt/profile-tools/fixture-checkout <<'TOOL'
#!/bin/sh
printf '%s:%s' "$(id -u)" "$FIXTURE_VALUE"
TOOL
chmod 755 /opt/profile-tools/fixture-checkout
setpriv --reuid=${UID} --regid=${UID} --clear-groups git -C ${WORKSPACE_DIR} init -b main
cat > ${WORKSPACE_DIR}/package.json <<'PACKAGE'
{"name":"runner-fixture","version":"1.0.0","scripts":{"postinstall":"id -u > .install-uid"}}
PACKAGE
cat > ${WORKSPACE_DIR}/package-lock.json <<'LOCK'
{"name":"runner-fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"runner-fixture","version":"1.0.0","hasInstallScript":true}}}
LOCK
mkdir -p ${WORKSPACE_DIR}/target-matrix ${WORKSPACE_DIR}/.agents/personas
printf '%s' '${MATRIX_TEXT}' > ${WORKSPACE_DIR}/target-matrix/read.txt
printf '%s' '${MATRIX_TEXT}' > ${WORKSPACE_DIR}/target-matrix/image.png
printf '%s\n' '---' 'name: Matrix' 'description: Fixture' '---' 'Sentinel' > ${WORKSPACE_DIR}/.agents/personas/target-matrix.md
chown -R ${UID}:${UID} ${WORKSPACE_DIR}
setpriv --reuid=${UID} --regid=${UID} --clear-groups git -C ${WORKSPACE_DIR} add .
setpriv --reuid=${UID} --regid=${UID} --clear-groups git -C ${WORKSPACE_DIR} -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -m base
printf "/file-list/\\n" >> ${WORKSPACE_DIR}/.git/info/exclude
mkdir ${WORKSPACE_DIR}/file-list
index=0
while [ "$index" -lt 1050 ]; do
  : > ${WORKSPACE_DIR}/file-list/"$index".txt
  index=$((index + 1))
done
install -d -o ${UID} -g ${UID} -m 755 /workspace-selection
printf private > ${WORKSPACE_DIR}/.root-only
chmod 600 ${WORKSPACE_DIR}/.root-only
printf guard > ${WORKSPACE_DIR}/.exec-probe
install -d -o ${UID} -g ${UID} -m 755 ${BARE_REMOTE}
setpriv --reuid=${UID} --regid=${UID} --clear-groups git clone --bare ${WORKSPACE_DIR} ${BARE_REMOTE}
git config --file /home/workload/.gitconfig url.file://${BARE_REMOTE}.insteadOf ${REPOSITORY_URL}
chown ${UID}:${UID} /home/workload/.gitconfig
install -m 600 /etc/runner/managed.json /run/cfg/managed.json
/opt/bin/runner remote-runner /run/cfg/managed.json &
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
  let managedListener: ReturnType<typeof acceptRemoteRunner> | undefined;
  const cleanup = () => {
    try {
      run("docker", ["rm", "-f", container]);
    } catch {
      // Never started.
    }
    listener?.close();
    managedListener?.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const binary = compile(dir, arch);
    const credentials = certificates(config);
    listener = acceptRemoteRunner(credentials, {
      runnerId: id,
    });
    managedListener = acceptRemoteRunner(credentials, {
      runnerId: id + "-managed",
    });
    const baseConfig = {
      ca: "/etc/runner/ca.pem",
      cert: "/etc/runner/runner.pem",
      key: "/etc/runner/runner.key",
      uid: UID,
      gid: UID,
      home: "/home/workload",
      path: "/opt/conformance-only-path:/usr/local/bin:/usr/bin:/bin",
      bins: { claudeBin: "/usr/local/bin/fixture-engine", codexBin: null },
      adapter: ["/opt/bin/acp-fixture"],
    };
    const endpoint = (port: number) => `https://host.docker.internal:${port}`;
    writeFileSync(
      join(config, "runner.json"),
      JSON.stringify({
        ...baseConfig,
        endpoint: endpoint(await listener.port),
        state: "/var/lib/runner",
      })
    );
    writeFileSync(
      join(config, "managed.json"),
      JSON.stringify({
        ...baseConfig,
        endpoint: endpoint(await managedListener.port),
        state: MANAGED_STATE,
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
    const [accepted, managed] = await Promise.race([
      Promise.all([listener.accepted, managedListener.accepted]),
      timeout,
    ]).finally(() => clearTimeout(timer));
    const rootExec = (...args: string[]) =>
      run("docker", ["exec", container, ...args]);
    const workload = (...args: string[]) =>
      rootExec(
        "setpriv",
        `--reuid=${UID}`,
        `--regid=${UID}`,
        "--clear-groups",
        ...args
      );
    const key = (session: Parameters<typeof sessionToWire>[0]) =>
      "opaque-" +
      createHash("sha256").update(sessionToWire(session)).digest("base64url");
    const checkout = (session: Parameters<typeof sessionToWire>[0]) =>
      `${MANAGED_STATE}/sessions/${key(session)}/checkout`;
    // The fixture binds each session to the directory seeded by the scenario.
    const runner: Runner = {
      ...accepted.runner,
      async call(op, request, options) {
        if (op === "session.launch") {
          await accepted.runner.call("workspace.prepare", {
            session: (request as Req<"session.launch">).session,
            source: { directory: pathFromWire(WORKSPACE_DIR) },
            copyIgnored: [],
            installDependencies: false,
          });
        }
        return accepted.runner.call(op, request, options);
      },
    };
    await runner.call("session.launch", launchRequest(SESSION));
    {
      const target = { session: SESSION, checkout: "current" } as const;
      const path = ".exec-probe";
      const manifest = await accepted.runner.call("checkout.read", {
        target,
        path,
        mode: "command-manifest",
        encoding: "utf8",
        maxBytes: 256 * 1024,
      });
      if (!manifest?.digest) throw new Error("Missing checkout command guard.");
      const exec = {
        target,
        guard: { path, digest: manifest.digest },
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
      runner,
      session: SESSION,
      github: {
        async signedIn(value) {
          rootExec("mkdir", "-p", "/home/workload/.config/gh");
          rootExec("chown", "-R", `${UID}:${UID}`, "/home/workload/.config");
          const marker = "/home/workload/.config/gh/fixture-signed-in";
          if (value) rootExec("touch", marker);
          else rootExec("rm", "-f", marker);
        },
      },
      workspace: {
        runner: checked(managed.runner),
        repository: REPOSITORY_URL,
        selectionDirectory: "/workspace-selection",
        async interrupt(session) {
          const receipt = `${MANAGED_STATE}/bindings/workspace/${key(session)}/workspace-preparation`;
          rootExec(
            "node",
            "-e",
            `
            const fs = require('node:fs');
            const [receipt, binding] = process.argv.slice(1);
            const state = JSON.parse(fs.readFileSync(receipt, 'utf8'));
            state.pending = { path: state.worktree.path, branch: state.worktree.branch };
            delete state.worktree;
            fs.writeFileSync(receipt, JSON.stringify(state));
            fs.unlinkSync(binding);
            fs.unlinkSync(binding + '.repository');
          `,
            receipt,
            `${MANAGED_STATE}/bindings/${key(session)}`
          );
        },
        async proveRelease(external, externalSession) {
          const runner = checked(managed.runner);
          const check = (condition: unknown, message: string) => {
            if (!condition) throw new Error(message);
          };
          const owner = sessionFromWire("release-owner");
          const other = sessionFromWire("release-other");
          const missing = sessionFromWire("release-missing");
          const borrower = sessionFromWire("release-borrower");
          const prepare = async (session: typeof owner, branch: string) => {
            await runner.call("workspace.prepare", {
              session,
              source: {
                repository: `file://${BARE_REMOTE}`,
                checkout: { kind: "new", branch },
              },
              copyIgnored: [],
              installDependencies: false,
            });
          };
          const release = (
            session: typeof owner,
            originalBranch: string | null,
            deleteBranch = true
          ) =>
            runner.call("workspace.release", {
              session,
              deleteBranch,
              originalBranch,
            });
          const binding = (session: typeof owner) =>
            `${MANAGED_STATE}/bindings/${key(session)}`;
          const parent = (session: typeof owner) =>
            checkout(session).slice(0, -"/checkout".length);
          const absent = (path: string) =>
            rootExec(
              "sh",
              "-c",
              'test ! -e "$1" && test ! -L "$1" && printf yes',
              "sh",
              path
            ) === "yes";
          const refuses = async (session: typeof owner, message: string) => {
            const result = await release(session, "release-original").catch(
              (error: unknown) => {
                if (!(error instanceof RunnerCallError)) throw error;
                return error;
              }
            );
            check(
              result instanceof RunnerCallError || !result.removed,
              message
            );
          };

          check(
            !(
              await external.call("workspace.release", {
                session: externalSession,
                deleteBranch: true,
                originalBranch: "main",
              })
            ).removed,
            "An external directory binding was accepted for removal."
          );
          check(
            rootExec("cat", WORKSPACE_DIR + "/.root-only") === "private",
            "External checkout changed."
          );

          await prepare(owner, "release-original");
          await prepare(other, "release-other");
          const own = checkout(owner);
          const foreign = checkout(other);
          workload("touch", foreign + "/sentinel");
          const git = (...args: string[]) =>
            workload("git", "-C", own, ...args).trim();
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
            "unmerged current"
          );
          rootExec(
            "sh",
            "-c",
            'printf "\\000managed:%s" "$2" > "$1"',
            "sh",
            binding(borrower),
            key(owner)
          );
          check(
            !(await release(borrower, "release-original")).removed,
            "A borrower released its owner's worktree."
          );
          check(
            rootExec("ls", own + "/.git").trim() !== "",
            "Borrower removed owner files."
          );

          rootExec("mv", parent(owner), parent(owner) + "-saved");
          rootExec("ln", "-s", parent(other), parent(owner));
          try {
            await refuses(owner, "A symlinked session parent was accepted.");
            rootExec("test", "-f", foreign + "/sentinel");
            rootExec("test", "-f", parent(owner) + "-saved/checkout/.git");
          } finally {
            rootExec("unlink", parent(owner));
            rootExec("mv", parent(owner) + "-saved", parent(owner));
          }
          rootExec("mv", own, own + "-saved");
          rootExec("ln", "-s", WORKSPACE_DIR, own);
          try {
            await refuses(
              owner,
              "An outside checkout replacement was accepted."
            );
            check(
              rootExec("cat", WORKSPACE_DIR + "/.root-only") === "private",
              "Outside checkout changed."
            );
          } finally {
            rootExec("unlink", own);
            rootExec("mv", own + "-saved", own);
          }

          workload("ln", "-s", foreign, own + "/outside");
          const hold = own + "/root-only";
          rootExec("mkdir", "-m", "700", hold);
          rootExec("touch", hold + "/sentinel");
          try {
            await refuses(
              owner,
              "Release traversed a directory accessible only to root."
            );
            rootExec("test", "-f", hold + "/sentinel");
          } finally {
            rootExec("rm", "-f", hold + "/sentinel");
            rootExec("rmdir", hold);
          }
          check(
            (await release(owner, "release-original")).removed,
            "Authorized release was refused."
          );
          check(
            absent(parent(owner)) && absent(binding(owner)),
            "Release left its directory or binding."
          );
          rootExec("test", "-f", foreign + "/sentinel");
          const branches = () =>
            workload(
              "git",
              "-C",
              foreign,
              "branch",
              "--format=%(refname:short)"
            ).split("\n");
          check(
            !branches().includes("release-current"),
            "The current unmerged branch was not force deleted."
          );
          check(
            !branches().includes("release-original"),
            "The original branch with zero commits ahead survived."
          );
          check(
            (await release(owner, "release-original")).removed,
            "Repeating release failed."
          );

          for (const tracked of [false, true]) {
            const session = sessionFromWire(`release-retain-${tracked}`);
            const branch = `retain-original-${tracked}`;
            await prepare(session, branch);
            const git = (...args: string[]) =>
              workload("git", "-C", checkout(session), ...args);
            git("branch", "--set-upstream-to=origin/main", branch);
            if (tracked) {
              git(
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "ahead of upstream"
              );
            }
            // New branches may already track their start point.
            if (!tracked) git("branch", "--unset-upstream", branch);
            git("switch", "-c", `retain-current-${tracked}`);
            check(
              (await release(session, branch)).removed,
              "Branch-policy release failed."
            );
            check(
              branches().includes(branch),
              "Release deleted an original branch without a fully merged upstream."
            );
          }

          await prepare(missing, "release-missing");
          rootExec("rm", "-rf", parent(missing));
          check(
            (await release(missing, "release-missing", false)).removed,
            "Missing checkout was not treated as removed."
          );
          check(absent(binding(missing)), "Missing checkout kept its binding.");
          check(
            branches().includes("release-missing"),
            "Release with deleteBranch=false deleted the branch."
          );
        },
        async proveIsolation(session, path) {
          const expected = checkout(session);
          if (path !== expected)
            throw new Error(
              "The checkout moved outside its protected location."
            );
          const parent = expected.slice(0, -"/checkout".length);
          const modes = rootExec(
            "stat",
            "-c",
            "%u:%g:%a",
            MANAGED_STATE,
            `${MANAGED_STATE}/sessions`,
            parent,
            expected,
            `${MANAGED_STATE}/bindings/workspace`,
            `${MANAGED_STATE}/repositories`
          )
            .trim()
            .split("\n");
          if (
            modes.slice(0, 3).some((mode) => mode !== `0:${UID}:751`) ||
            !modes[3]?.startsWith(`${UID}:${UID}:`) ||
            modes[4] !== "0:0:700" ||
            modes[5] !== "0:0:711"
          )
            throw new Error(
              "Wrong checkout ownership or ancestor permissions: " +
                modes.join(", ")
            );
          const cacheKey = createHash("sha256")
            .update("file/" + BARE_REMOTE.slice(1, -".git".length))
            .digest("hex");
          if (
            rootExec(
              "stat",
              "-c",
              "%u:%g:%a",
              `${MANAGED_STATE}/repositories/${cacheKey}`
            ).trim() !== `${UID}:${UID}:700`
          )
            throw new Error("The clone cache is not private to the workload.");
          if (
            workload("cat", expected + "/.install-uid").trim() !== String(UID)
          )
            throw new Error(
              "The dependency install did not run as the workload."
            );
          const denied = (args: string[], expectedCode = "EACCES") => {
            const result = workload(
              "node",
              "-e",
              `
              const fs = require('node:fs');
              const [operation, a, b] = process.argv.slice(1);
              try { fs[operation](a, b); process.stdout.write('succeeded'); }
              catch (error) { process.stdout.write(error.code); }
            `,
              ...args
            );
            if (result !== expectedCode)
              throw new Error(args[0] + " returned " + result);
          };
          denied(["renameSync", parent, parent + "-moved"]);
          denied(["symlinkSync", "/", parent + "/replacement"], "EACCES");
          denied(["renameSync", expected, parent + "/checkout-old"]);
          denied(["accessSync", `${MANAGED_STATE}/bindings/workspace/.`]);
          // A root-only subtree inside the checkout forces the workload's find
          // to fail. A root find could delete it and incorrectly succeed.
          const hold = expected + "/root-only";
          rootExec("mkdir", "-m", "700", hold);
          rootExec("touch", hold + "/file");
          try {
            await managed.runner.call("session.discard", { session });
            throw new Error(
              "Removal deleted a directory only root could traverse."
            );
          } catch (error) {
            if (
              !(error instanceof RunnerCallError) ||
              !error.message.includes("Permission denied")
            )
              throw error;
          } finally {
            rootExec("rm", "-f", hold + "/file");
            rootExec("rmdir", hold);
          }
          await managed.runner.call("session.discard", { session });
          if (
            rootExec(
              "sh",
              "-c",
              'test ! -e "$1" && printf removed',
              "sh",
              parent
            ) !== "removed"
          )
            throw new Error("The checkout parent survived removal.");
        },
      },
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
        managed.close();
        cleanup();
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
