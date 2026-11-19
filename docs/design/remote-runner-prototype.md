# Dispatch remote runners

One Dispatch instance can run agents on this Mac and on multiple named Linux
runners. Dispatch owns the agents, tasks, conversations, permissions UI and
stream projection. Each runner owns its workspaces and engine processes.

For released systemd installations, see
[Install a managed Dispatch runner on Linux](../remote-runner-linux.md).
The instructions below describe the manual prototype path.

1. Prepare the Linux runner binary, workload account, workspace and
   `/etc/dispatch-runner/runner.json` as described below. Configure the
   workload settings before pairing.
2. In **Settings → Connections → Remote runners**, enter a name and choose
   **Pair runner**. Run the displayed one-time command as root on the runner.
   Dispatch issues the certificate. The private key is generated on the runner.
3. Start the runner supervisor with its updated configuration. In Settings,
   wait for **Online** and check the advertised workspace list.
4. Open **Create Agent**. **Runs on** defaults to **This Mac**. Choose the
   named runner and workspace for a remote launch. Workspaces on different
   runners may have the same name.
5. To remove a runner's access, choose **Revoke** for that registration.
   Each agent stays bound to its original runner, including after disconnect
   and when a new runner is paired under a previously used name.

The deterministic integration suite builds the Linux runner and exercises two
Docker containers plus a local agent against a disposable Dispatch database.
Run it from the worktree with Bun, Docker and Playwright installed.

```sh
pnpm run test:e2e:remote-runners --no-deps acceptance.spec.ts
```

## Linux runner setup

Build the Linux artifact from this checkout. For x86-64 use the matching Bun
target. The server and runner use the same source entry point.

```sh
bun scripts/generate-server-runtime-assets.mjs
bun build --compile --target=bun-linux-arm64 apps/server/src/main.ts \
  --outfile /tmp/dispatch-runner
```

Run `dispatch-runner remote-runner /etc/dispatch-runner/runner.json` under a
Linux service supervisor. The root-owned runner JSON names the HTTPS
`endpoint`, trust and enrollment PEM paths `ca`, `cert`, and `key`, the
dedicated `state` directory, guest CLI `uid`, `gid`, `home`, and `path`,
engine `bins`, and a `workspaces` object keyed by handle. Each workspace
defines its guest `cwd` and can define a fixed `repoTool` argv array. The
optional `trustBundle` supplies a combined system and test trust bundle for
clients that use `SSL_CERT_FILE`. There is a guest-local `adapter` override
for the fake provider. Keep the enrollment key and runner settings root-only
and the CA certificate readable by the CLI. The supervisor needs Linux
util-linux `/usr/bin/setpriv` and permission to change identity and remove
capabilities (`CAP_SETUID`, `CAP_SETGID`, and `CAP_SETPCAP`). Install `procps`
to provide `ps` on the supervisor’s PATH for stopping agents and cleaning up
their processes during archive. Before accepting execution commands,
the runner verifies the kernel-reported non-root UID/GID, empty supplementary
groups, zero capabilities, and `no_new_privs` through the same wrapper used
for both the ACP host and repo operations. The runner grants traversal on its
root and host-state parent even when the supervisor uses umask `0077`.
Bindings and logs remain private. The child receives its scoped MCP credential
and guest paths through a constructed environment. Use test credentials, disable VM
mounts and SSH-agent forwarding, and keep the VM and dev data disposable.

## Registration and networking

Enrollment replaces the manual certificates and approval file. On first use
Dispatch creates a runner CA and a listener certificate and stores them in
PostgreSQL (`runner_authority`). `POST /api/runners {name}` returns
`{id, command, expiresAt}`. The command looks like
`dispatch-runner remote-runner-pair --endpoint https://HOST:PORT --ca-sha256 HEX --code CODE`.
The code is single-use, expires after ten minutes, and is stored only as a
hash. Run the command as root on the runner host. Add `--dir` (default
`/etc/dispatch-runner`) or `--config FILE` as needed. The CLI pins the CA
fingerprint before it sends the code. It generates the private key locally and
writes `key.pem` (0600), `cert.pem` and `ca.pem`. It also sets `endpoint`, `ca`,
`cert` and `key` in `runner.json` and leaves the rest of that file untouched.
`GET /api/runners` lists `pending`, `online`, `offline` and `revoked`
registrations along with their last reported workspaces.
`DELETE /api/runners/:id` revokes a registration and drops its connection
immediately. Each registration is an independent mTLS peer, addressed as
`runner://<registration id>/<workspace>`. Names are display labels and can
be reused after revocation. A replacement gets a new id, so an old agent never
reaches it. `POST /api/runners/:id/pair` renews or re-keys a runner. It issues
a new one-time command for the same id, and pairing with it retires the old
certificate and connection. Restart the runner service afterwards.

The listener binds `DISPATCH_RUNNER_HOST`, which defaults to all interfaces (`0.0.0.0`) even when the API itself is loopback-only. It opens only once a registration exists. It
uses `DISPATCH_RUNNER_PORT` when set. Otherwise it uses the persisted port, and
on first start a free port. `DISPATCH_RUNNER_ENDPOINT_HOST` overrides the host
written into commands. Otherwise the host comes from the request's Host header. A loopback
request, such as the desktop app on `localhost`, advertises this machine's
private LAN IPv4 address instead, falling back to its hostname.
The listener certificate gains each advertised host automatically. Unless
`DISPATCH_RUNNER_MCP_ORIGIN` is set, the agent MCP origin is the runner
listener itself. It forwards `/api/mcp/<agentId>` only with that agent's
own MCP token, and forwards `GET /ping`. It passes on only allow-listed
headers, so no cookies, origin, forwarding or admin headers. It refuses
every other path, including the admin API token.
`DISPATCH_RUNNER_REPO_TOOL` approves the repo operation for `1` (every placement) or a
comma list of `<id>` or `<id>/<workspace>`.
`DISPATCH_RUNNERS=0` disables enrollment. The legacy
`DISPATCH_REMOTE_SERVICE_CONFIG` below still works. Its `mcpOrigin` is now
optional when `endpointHost` is given.

## Runner-initiated enrollment

`dispatch-runner connect <service-url>
[--dir /etc/dispatch-runner] [--config FILE]` enrolls without a pairing
command typed on the runner: the runner dials the Dispatch service itself.
`GET /api/runners/connect-command` (authenticated) gives an operator the
exact invocation to run — it always targets the runner listener's own
pinned CA and port, so it works even when the ordinary API is loopback-only
or plain HTTP, and it is reusable: the runner supplies its own one-time
code, so the same command can be copied onto any number of clean runners.

The runner generates its keypair locally (the private key never leaves the
host, as with the operator-initiated flow above) and
`POST /api/runners/connect` with only its public key, reached either
directly or, for a runner that only has the listener's own pinned CA,
proxied through that listener the same way `/ping` already is. The service
returns a short operator-facing code and an opaque high-entropy request id
for the CLI's own polling. The CLI prints the code and polls
`GET /api/runners/connect/:id` (addressed only by that same opaque id)
until an operator approves it.

Settings supplies a single HTTPS service URL. For Dispatch's private listener
the URL fragment carries the SHA-256 fingerprint of the service CA, encoded
in base64url. The runner verifies it locally before requesting a code. A bare
HTTPS service URL uses the runner host's normal certificate trust store.

The create response supplies the browser approval link alongside the code.
Dispatch uses its web listener address, or the public web origin configured
by the service when it serves the UI separately (including Vite previews).
The runner prints the link supplied by the service. Older commands with
`--service`, `--ca-sha256` and `--approval-url` are still accepted.

The operator reads the code off the runner's own terminal or logs — it is
never sent back by the runner — and calls the authenticated
`POST /api/runners/connect/:id/approve {code, name}`. Approval is key-bound:
it issues a client certificate only for the public key submitted when the
request was created, so a code observed or guessed in transit can never
redeem a different key. The code is a 10-minute, 8-character one-time value;
five wrong attempts void the request outright, forcing the runner to connect
again. `DELETE /api/runners/connect/:id` denies a pending request.
`GET /api/runners/connect` (authenticated) lists pending requests without
exposing their code or key.

Approval issues the same kind of mTLS client certificate as pairing above,
automatically and without a second step, and the poll response that follows
carries the certificate, the CA, and the `endpoint` to dial — the same
`runner.json` fields `remote-runner-pair` writes. `--ca-sha256` pins the
service's certificate chain for a self-signed deployment the same way
pairing's bootstrap does: the CLI confirms the CA over the same
`ca_request`/`ca` wire-protocol exchange first, then makes the real request
over an ordinary, fully chain-and-hostname-verified TLS connection trusting
only that CA. Without `--ca-sha256`, the service is expected to hold an
ordinarily trusted certificate.

## Legacy manual enrollment

Set `DISPATCH_REMOTE_SERVICE_CONFIG` on an isolated Dispatch service. The
service JSON names one registration `id`, listener `host` and `port`, PEM
paths `ca`, `cert`, and `key`, an `approval` file containing the approved
client certificate's SHA-256 fingerprint, a list of approved `workspaces`, and
the guest-reachable HTTPS `mcpOrigin`. Set `repoTool` to true to expose the
approved repository operation. For the Lima proof the API stayed on the dev
stack's own loopback port and a scoped HTTPS front end forwarded `/ping` and
agent MCP routes. The server certificate included `host.lima.internal` in its
SAN. Empty the approval file to revoke the live connection and prevent further
attachment. Reapproval restores access to the same registration.

## Wire contract

The [portable protocol package](../../packages/runner-protocol/README.md)
defines the v1 wire types, opaque locators, optional service MCP, and
consumer receipt and replay semantics. The original single-runner traces appear below.

The runner sends `ready` with protocol version 1 and its workspace handles.
The service requires a trusted client certificate, an active registration or legacy approval
fingerprint, and a workspace offered by that runner. A service request
names an agent ID, workspace, operation, and a per-connection correlation ID.
The runner stores the agent-to-workspace binding in its private state and
rechecks it on every attach and workspace operation. Reply frames correlate
results or errors to the request. Transport close drops channels, while
established guest hosts continue. The client checks the service hostname.

- `launch` sends engine, model and effort, access and prompt metadata, and
  agent-scoped MCP URL and token. Guest configuration supplies the checkout,
  binary, environment, and writable state. The launch receipt means the host
  was spawned. The host's running `welcome` confirms the ACP session.
- `attach` opens a channel to the bound guest host's Unix socket. The host
  protocol is carried as opaque bytes in `data` frames. `hello` names the
  last applied sequence and journal identity, and `welcome` reports the
  running session, journal head, open turn, capabilities, and permissions.
  Replay follows in sequence and ends with `replay_complete`. A different
  identity or a cursor past the head restarts replay. Dispatch stores the
  journal ID and cursor in PostgreSQL and drops repeated sequences.
- `prompt` uses an operation ID and journal ID. Dispatch flushes the ID and
  source blocks to its scoped agent state before sending. The host flushes its
  claim before handing the prompt to ACP and its accepted receipt before
  replying. Acceptance confirms handoff to ACP. Retrying an accepted ID on the
  same journal returns its receipt without invoking the provider. A claimed
  ID without a receipt or an ID addressed to the wrong journal reports an
  unknown outcome. Dispatch surfaces a lost acknowledgement and never
  automatically resubmits that prompt. A terminal event independently settles
  the projected turn.
- Pending permissions appear as `permissions` messages and are also included
  in `welcome`. `answer_permission` is scoped to the pending request and
  returns `permission_answered`. `cancel` and the sequence-targeted
  `interrupt` use the existing host handlers. `interrupt_result` confirms
  the cancel call returned. The turn's terminal event reports the outcome.
- `alive`, `stop`, `log`, and `discard` operate at the runner. A missing
  transport is an unknown liveness result. A connected runner can report a
  known missing host. On host exit the runner cleans up remaining processes
  with the launch's inherited ownership marker.
- `repo_runner_workspace` is available only on the authenticated agent MCP
  route for a remote placement and an explicitly enabled service. It has no
  caller-controlled arguments. The runner executes the approved workspace
  command as the guest CLI account and returns its bounded stdout. Product
  `post` runs through the usual Dispatch MCP route and permissions.

### Inspecting and sharing a live checkout

A service can inspect the checkout bound to an existing agent ID when the connected peer advertises `checkoutInspection: true`. The built-in local runner handles the same typed query in process. The Linux runner resolves the session binding and executes the inspection as the workload account.

| Request                                              | Reply                                                                                                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspectCheckout` with `{kind:"changes",baseBranch}` | Effective base ref, HEAD commit, a state identifier for the inspected changes, and repo-relative changed paths. The paths include committed, staged, unstaged and untracked files. |
| `inspectCheckout` with `{kind:"readFile",path}`      | Bounded text from a regular file relative to the checkout root, or null if absent.                                                                                                 |

A service interprets checkout contents according to its own policy. Dispatch reads the ownership map and persona definitions and selects the reviewers. An independent consumer can use the same operations without implementing those concepts.

With `sharedWorktree: true`, a launch can specify `useWorktreeOf`, an existing agent ID bound to the same runner and workspace. A launch supplies either that reference or a repository to provision. The new agent has its own host, identity, journal and credentials. Referencing a live worktree gives it access to the author's current files, including edits made after the review started. The state identifier lets the service compare what it inspected across requests. File write permissions depend on the workload and engine access policy. The checkout reference itself grants no read-only guarantee.

The service checks advertised capabilities on each connection before sending a dependent command. A peer without the extension can continue its existing sessions. Callers receive an actionable unsupported error if they request checkout inspection or sharing. A failed remote inspection must never resolve the runner locator as a local path.

## Observed traces

The initial fake-agent turn ran as `agt_4643ddec746a`. The UI showed
`3ce751fe-1cda-42fe-9c7a-cdf03b4b0a92` from the guest-only marker and the
same value in its MCP post. On the restricted launch
`agt_240a31e28e6a`, Dispatch showed the permission request. Denying it left
the protected action file absent. The approved repo operation wrote
`/opt/dispatch-guest-b87cc218` to a file in the guest checkout. The ordinary
Mac launch path completed before and after the guest proof.

For service restart, the guest journal opened the turn at sequence 7 and
produced its first chunk at 8. A scoped Dispatch restart replaced the service
process. The guest retained PID 1917, session `sess_1`, and journal
`1c98b164-0222-4d67-8c56-172f8819e496`. The resumed projection showed one
completion. A separate guest network interruption reset the connection and
briefly blocked only the runner port while the HTTPS MCP listener stayed
reachable. The same guest showed one completed turn after reconnect. Killing
the guest host during another turn caused Dispatch to mark that turn interrupted.
The certificate proof observed the established connection disappear on
revocation, rejected both a CA-signed unapproved certificate and a peer with no
certificate, and showed that the revoked client could reconnect only after
reapproval.

A separate wire probe dropped the return path immediately after writing prompt
`6869a0de-ea67-470b-9376-737431421dd5` to the Lima guest host. Retrying that ID
on the same journal returned `prompt_accepted`. The fake provider counter
increased by exactly one and the journal contained one terminal event. The
regression test in `test/acp-host.test.ts` repeats the receipt and counter check
with the real ACP host and fake provider.

Real CLI acceptance used OpenCode 1.19.6 on Linux arm64 with the anonymous
`opencode/glm-5.3-flash-free` model and synthetic fixture data. The CLI read a
fresh marker `e065e5ae-2f73-4d65-a88b-1f2ed704fa4e` in
`agt_d8b725faeaae`, posted it into the launch discussion and ran the approved
repo operation. A later stop from the normal Dispatch composer settled with
`stopReason: cancelled` in the same guest journal. The provider reported zero
cost. The installed runner's SHA-256
was `6f168024ce1d1db0d0a2c07039f6836fb070b0d0d6aa4d5b71aea56b141baedd`.

## Exit decision

The Lima slice supports bounded operations for launching, attaching, prompting,
permissions, stopping, and invoking an approved repo tool. It supports trying the
same Linux artifact on a second host. General scheduling, checkout provisioning,
arbitrary repo tool manifests, file transfer and git views are still machine-local
features outside this slice. This original Lima run used one manually enrolled runner and a pre-provisioned
workspace. The current Linux runner also recovers live hosts across daemon
restarts. The multi-runner acceptance suite kills the daemon during a turn
and checks the host PID, provider invocation count and visible completion. The guest connection uses Lima's host-loopback reachability and
establishes process and filesystem separation. Subsequent Cloudy and scoped Hangar runs are recorded in the
[implementation handoff](remote-runner-handoff.md).
