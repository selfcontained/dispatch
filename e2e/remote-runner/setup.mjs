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
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const RUNNERS = ["alpha", "beta", "scratch"];
const WORKSPACE = "proof"; // identical handle on every runner, on purpose
const WORKSPACE_DIR = "/opt/dispatch-guest-proof";
// The supervisor uses procps to reap engine descendants during archive.
const IMAGE = process.env.REMOTE_E2E_IMAGE ?? "node:22-bookworm";
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

// All three containers share this pair for the lifetime of the run.
function artifacts(arch, run) {
  const dir = path.join(run, "compiled-runner");
  mkdirSync(dir, { mode: 0o700 });
  const runner = path.join(dir, "dispatch-runner");
  const adapter = path.join(dir, "remote-acp-fixture");
  sh("bun", ["scripts/generate-server-runtime-assets.mjs"], { cwd: root });
  const target = `bun-linux-${arch === "arm64" ? "arm64" : "x64"}`;
  for (const [entry, outfile] of [
    ["apps/server/src/main.ts", runner],
    ["apps/server/test/helpers/remote-acp-fixture.ts", adapter],
  ]) {
    sh(
      "bun",
      ["build", "--compile", `--target=${target}`, entry, "--outfile", outfile],
      { cwd: root }
    );
  }
  return { runner, adapter };
}

async function up(run) {
  const id = path.basename(run);
  mkdirSync(run, { recursive: true, mode: 0o700 });
  const providerFixture = path.join(run, "provider-fixture");
  mkdirSync(providerFixture, { mode: 0o700 });
  // An expired synthetic Claude login also prevents the macOS Keychain
  // fallback. The adapter itself never needs a provider login.
  writeFileSync(
    path.join(providerFixture, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: "fake-expired-e2e-token", expiresAt: 1 },
    }),
    { mode: 0o600 }
  );
  const arch =
    sh("docker", ["version", "--format", "{{.Server.Arch}}"]).trim() === "arm64"
      ? "arm64"
      : "x64";
  const bin = artifacts(arch, run);
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
        bins: { claudeBin: "/usr/local/bin/fixture-claude", codexBin: null },
        adapter: ["/opt/bin/remote-acp-fixture"],
        workspaces:
          name === "scratch"
            ? {}
            : {
                [WORKSPACE]: {
                  cwd: WORKSPACE_DIR,
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
      workspaceDir: WORKSPACE_DIR,
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
      `export DISPATCH_RUNNER_PORT=${runnerPort}`,
      "export DISPATCH_RUNNER_ENDPOINT_HOST=host.docker.internal",
      `export CLAUDE_CONFIG_DIR='${providerFixture}'`,
      `export CODEX_HOME='${providerFixture}'`,
      `export REMOTE_E2E_STATE='${path.join(run, "state.json")}'`,
      "",
    ].join("\n")
  );
  console.log(`remote e2e ready: ${run}`);
}

function down(run) {
  const id = path.basename(run);
  let containersRemoved = false;
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
    containersRemoved = true;
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
    rmSync(path.join(run, "pids"), { force: true });
  } catch {}
  if (!containersRemoved) {
    process.exitCode = 1;
    return;
  }
  const dir = path.join(run, "compiled-runner");
  for (const binary of ["dispatch-runner", "remote-acp-fixture"]) {
    rmSync(path.join(dir, binary), { force: true });
  }
  try {
    rmdirSync(dir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
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
