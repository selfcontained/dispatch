#!/usr/bin/env node
// Reproducible setup/teardown for the remote runner acceptance run.
//   node setup.mjs up   <run-dir>   build artifacts, chaos proxy, idle runner containers
//   node setup.mjs down <run-dir>              remove containers and processes
// No VMs, no production data: everything lives under <run-dir> and in
// containers labelled dispatch-remote-e2e=<run id>.
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const RUNNERS = ["alpha", "beta"];
const WORKSPACE = "proof"; // identical handle on every runner, on purpose
// Colima/Docker Desktop share $HOME, not /tmp, with the VM; bind mounts must live here.
export const base =
  process.env.REMOTE_E2E_ROOT ??
  path.join(process.env.HOME, ".cache", "dispatch-remote-e2e");
const IMAGE = process.env.REMOTE_E2E_IMAGE ?? "debian:bookworm-slim";
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...opts,
  });

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

function artifacts(arch) {
  const hash = createHash("sha256")
    .update(
      sh(
        "git",
        ["ls-files", "-s", "apps/server/src", "apps/server/test/helpers"],
        { cwd: root }
      )
    )
    .update(
      sh(
        "git",
        ["diff", "HEAD", "--", "apps/server/src", "apps/server/test/helpers"],
        { cwd: root }
      )
    )
    .digest("hex")
    .slice(0, 16);
  const dir = path.join(base, `bin-${arch}-${hash}`);
  const runner = path.join(dir, "dispatch-runner");
  const adapter = path.join(dir, "remote-acp-fixture");
  if (!existsSync(runner) || !existsSync(adapter)) {
    mkdirSync(dir, { recursive: true });
    sh("bun", ["scripts/generate-server-runtime-assets.mjs"], { cwd: root });
    const target = `bun-linux-${arch === "arm64" ? "arm64" : "x64"}`;
    sh(
      "bun",
      [
        "build",
        "--compile",
        `--target=${target}`,
        "apps/server/src/main.ts",
        "--outfile",
        runner,
      ],
      { cwd: root }
    );
    sh(
      "bun",
      [
        "build",
        "--compile",
        `--target=${target}`,
        "apps/server/test/helpers/remote-acp-fixture.ts",
        "--outfile",
        adapter,
      ],
      { cwd: root }
    );
  }
  return { runner, adapter };
}

async function up(run) {
  const id = path.basename(run);
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const arch =
    sh("docker", ["version", "--format", "{{.Server.Arch}}"]).trim() === "arm64"
      ? "arm64"
      : "x64";
  const bin = artifacts(arch);
  const runnerPort = await freePort(); // DISPATCH_RUNNER_PORT: the service's enrolled-mode listener
  const controlPort = await freePort();
  const lanes = [];
  const state = {
    id,
    controlPort,
    runnerPort,
    endpointHost: "host.docker.internal",
    workspace: WORKSPACE,
    runners: {},
  };
  for (const name of RUNNERS) {
    const proxyPort = await freePort();
    const dir = path.join(run, name);
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, "runner.json"),
      JSON.stringify({
        endpoint: "https://placeholder.invalid",
        ca: "/etc/dispatch-runner/ca.pem",
        cert: "/etc/dispatch-runner/cert.pem",
        key: "/etc/dispatch-runner/key.pem",
        state: "/var/lib/runner",
        uid: 1500,
        gid: 1500,
        home: "/home/guest",
        path: "/usr/local/bin:/usr/bin:/bin",
        bins: { claudeBin: "/bin/false", codexBin: null },
        adapter: ["/opt/bin/remote-acp-fixture"],
        workspaces: {
          [WORKSPACE]: {
            cwd: `/opt/dispatch-guest-${name}-proof`,
            repoTool: ["/bin/sh", "-c", "echo ran > repo-op"],
          },
        },
      })
    );
    copyFileSync(
      path.join(here, "entrypoint.sh"),
      path.join(dir, "entrypoint.sh")
    );
    chmodSync(path.join(dir, "entrypoint.sh"), 0o755);
    lanes.push(`${name}=${proxyPort}:${runnerPort}`);
    state.runners[name] = {
      container: `dispatch-remote-e2e-${id}-${name}`,
      proxyPort,
      workspaceDir: `/opt/dispatch-guest-${name}-proof`,
    };
  }
  const child = spawn(
    process.execPath,
    [path.join(here, "chaos-proxy.mjs"), String(controlPort), ...lanes],
    { detached: true, stdio: ["ignore", "pipe", "inherit"] }
  );
  await new Promise((resolve, reject) => {
    child.stdout.once("data", () => {
      // Release the pipe too, or setup.mjs never exits.
      child.stdout.destroy();
      child.unref();
      resolve();
    });
    child.once("exit", () => reject(new Error("chaos proxy exited")));
  });
  writeFileSync(path.join(run, "pids"), String(child.pid));
  for (const name of RUNNERS) {
    sh("docker", [
      "run",
      "-d",
      "--name",
      state.runners[name].container,
      "--label",
      `dispatch-remote-e2e=${id}`,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-v",
      `${path.join(run, name)}:/etc/runner:ro`,
      "-v",
      `${bin.runner}:/opt/bin/dispatch-runner:ro`,
      "-v",
      `${bin.adapter}:/opt/bin/remote-acp-fixture:ro`,
      "--entrypoint",
      "/bin/sh",
      IMAGE,
      "/etc/runner/entrypoint.sh",
      name,
    ]);
  }
  writeFileSync(path.join(run, "state.json"), JSON.stringify(state, null, 2));
  // Enrolled-mode service settings (no registration file; see enrollment slice).
  writeFileSync(
    path.join(run, "env"),
    [
      "export DISPATCH_RUNNER_HOST=0.0.0.0",
      "export DISPATCH_RUNNER_REPO_TOOL=1", // approved repo operation for every placement
      `export DISPATCH_RUNNER_PORT=${runnerPort}`,
      "export DISPATCH_RUNNER_ENDPOINT_HOST=host.docker.internal",
      `export REMOTE_E2E_STATE='${path.join(run, "state.json")}'`,
      "",
    ].join("\n")
  );
  console.log(`remote e2e ready: ${run}`);
}

function down(run) {
  const id = path.basename(run);
  try {
    const ids = sh("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=dispatch-remote-e2e=${id}`,
    ])
      .split(/\s+/)
      .filter(Boolean);
    if (ids.length) sh("docker", ["rm", "-f", ...ids]);
  } catch (e) {
    console.error("container cleanup:", e.message);
  }
  try {
    for (const pid of readFileSync(path.join(run, "pids"), "utf8")
      .split("\n")
      .filter(Boolean))
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {}
  } catch {}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, run] = process.argv.slice(2);
  if (cmd === "up") await up(path.resolve(run));
  else if (cmd === "down") down(path.resolve(run));
  else {
    console.error("usage: setup.mjs up|down <run-dir> [api-port]");
    process.exit(2);
  }
}
