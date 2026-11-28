#!/usr/bin/env bash
set -euo pipefail

archive=${1:?Usage: codex-cloudy-toolcheck.sh CODEX_LINUX_X64_TGZ}
image=${CODEX_PREFLIGHT_IMAGE:-oven/bun:1.3.13}
expected=944cbabe58a2c599a30141bc0220c31963205c33e69b43b414dd5da6adaf957f
digest=$(sha256sum "$archive" | cut -d ' ' -f1)
test "$digest" = "$expected"
printf 'Codex package SHA-256 %s\n' "$digest"

# An independent disposable container. Never mount a host home or supply auth.
container=$(docker create --network none --security-opt no-new-privileges \
  --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID \
  --cap-add SETPCAP --pids-limit 64 --memory 1g --user 0 \
  --entrypoint /bin/sleep "$image" 120)
trap 'docker rm -f "$container" >/dev/null' EXIT
docker cp "$archive" "$container:/codex-linux-x64.tgz"
docker start "$container" >/dev/null
test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")" = none
echo 'Container network mode: none'

docker exec -i "$container" /bin/sh -se <<'CONTAINER'
umask 022
mkdir -p /proof/home/.codex /proof/app/codex-distribution
chmod 700 /proof/home /proof/home/.codex
chown 1000:1000 /proof/home/.codex /proof/home
workspace=/opt/dispatch-guest-codex-preflight
mkdir -m 755 "$workspace"
marker=$(cat /proc/sys/kernel/random/uuid)
printf '%s\n' "$marker" > "$workspace/marker.txt"
# Keep the complete published layout. Codex resolves resources beside its binary.
tar --no-same-owner -xzf /codex-linux-x64.tgz -C /proof/app/codex-distribution
vendor=/proof/app/codex-distribution/package/vendor/x86_64-unknown-linux-musl
test -x "$vendor/bin/codex"
test -x "$vendor/bin/codex-code-mode-host"
test -x "$vendor/codex-resources/bwrap"
test -x "$vendor/codex-path/rg"
cat > /proof/preflight.mjs <<'JS'
import { readFile } from "node:fs/promises";

const vendor = process.argv[2];
const env = {
  HOME: "/proof/home",
  CODEX_HOME: "/proof/home/.codex",
  PATH: `${vendor}/bin:${vendor}/codex-path:${vendor}/codex-resources:/usr/bin:/bin`
};
async function verifyIdentity(path) {
  const status = await readFile(path, "utf8");
  checkIdentity(status);
}
function checkIdentity(status) {
  const kernelIdentity = Object.fromEntries(status.split("\n").map(line => {
    const [key, value] = line.split(":", 2);
    return [key, (value ?? "").trim().replace(/\s+/g, " ")];
  }));
  for (const [key, wanted] of Object.entries({
    Uid: "1000 1000 1000 1000",
    Gid: "1000 1000 1000 1000",
    Groups: "",
    NoNewPrivs: "1",
    CapInh: "0000000000000000",
    CapPrm: "0000000000000000",
    CapEff: "0000000000000000",
    CapBnd: "0000000000000000",
    CapAmb: "0000000000000000"
  })) {
    if (kernelIdentity[key] !== wanted) throw new Error(`Unexpected ${key}`);
  }
}
await verifyIdentity("/proc/self/status");
console.log("Preflight kernel identity: UID/GID 1000; empty groups; no capabilities; NoNewPrivs=1");

const spawn = (binary, ...args) => Bun.spawn([vendor + "/bin/" + binary, ...args], {
  cwd: env.HOME, env, stdin: "pipe", stdout: "pipe", stderr: "inherit"
});
const version = spawn("codex", "--version");
version.stdin.end();
const versionText = (await new Response(version.stdout).text()).trim();
if (await version.exited || versionText !== "codex-cli 0.167.1") {
  throw new Error("Unexpected Codex CLI version");
}
console.log(versionText);

const companion = spawn("codex-code-mode-host", "--listen", "stdio");
try {
  // Hold stdin open to distinguish the running IPC host from a process that
  // merely parsed --help, exited on startup, or did not load its executable.
  await Promise.race([
    companion.exited.then(code => { throw new Error(`Companion exited during startup: ${code}`); }),
    Bun.sleep(350)
  ]);
  await verifyIdentity(`/proc/${companion.pid}/status`);
  companion.stdin.end();
  if (await companion.exited) throw new Error("Code Mode companion failed on EOF");
  console.log("Code Mode companion opened stdio and shut down cleanly on EOF");
} finally {
  companion.kill();
}

const appServer = spawn(
  "codex", "app-server", "--listen", "stdio://",
  "-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"'
);
const reader = appServer.stdout.pipeThrough(new TextDecoderStream()).getReader();
let pending = "";
function send(message) {
  appServer.stdin.write(JSON.stringify({jsonrpc: "2.0", ...message}) + "\n");
  appServer.stdin.flush();
}
async function readResponse(id) {
  while (true) {
    const end = pending.indexOf("\n");
    if (end >= 0) {
      const message = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      if (message.id === id) {
        if (message.error) throw new Error(JSON.stringify(message.error));
        return message.result;
      }
      continue;
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("App server stream closed");
    pending += value;
  }
}
async function request(id, method, params) {
  send({id, method, params});
  return await Promise.race([
    readResponse(id),
    Bun.sleep(8000).then(() => { throw new Error(method + " timed out"); })
  ]);
}
try {
  await request(1, "initialize", {
    clientInfo: {name: "cloudy-offline-toolcheck", version: "1"}
  });
  send({method:"initialized"});
  console.log("Codex app-server returned local initialize response");
  const result = await request(2, "command/exec", {
    cwd: "/opt/dispatch-guest-codex-preflight",
    command: ["/bin/sh", "-ec", 'cat marker.txt; cat "/proc/$$/status"'],
    sandboxPolicy: {type: "dangerFullAccess"},
    timeoutMs: 5000
  });
  if (result.exitCode !== 0) throw new Error("command/exec failed: " + result.stderr);
  const end = result.stdout.indexOf("\n");
  if (result.stdout.slice(0, end) !== process.argv[3]) {
    throw new Error("command/exec did not return the matching guest-only marker");
  }
  checkIdentity(result.stdout.slice(end + 1));
  console.log("command/exec returned matching guest-only marker: " + process.argv[3]);
  console.log("Command kernel identity: UID/GID 1000; empty groups; no capabilities; NoNewPrivs=1");
  console.log("Policy: dangerFullAccess with approval_policy=never; no turn or provider call");
} finally {
  appServer.stdin.end();
  appServer.kill();
  await appServer.exited;
}

JS
chmod 644 /proof/preflight.mjs
/usr/bin/setpriv --reuid=1000 --regid=1000 --clear-groups --no-new-privs \
  --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- \
  /usr/bin/env -i HOME=/proof/home PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/bun /proof/preflight.mjs "$vendor" "$marker"
CONTAINER
