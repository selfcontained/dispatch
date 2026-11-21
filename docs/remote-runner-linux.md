# Install a managed Dispatch runner on Linux

Use a supported Dispatch release and a Linux x86-64 or ARM64 host with systemd,
the unified cgroup v2 hierarchy, and systemd's `freeze` and `thaw` commands.
Install Git, GNU grep, procps (ps), findutils, Bash, curl, tar, util-linux (including `/usr/bin/setpriv` and `flock`),
`useradd`, GNU coreutils, and a GitHub CLI with `gh attestation verify --bundle`.
The installer uses the tools already there and installs nothing; it lists
what it found and names anything missing. The runner uses the workload
account's own `gh` and `git` from its login shell PATH.
GitHub CLI verifies the published bundles without a GitHub login.
The runner must be able to reach the HTTPS address in the pairing command.
The published binary bundles Bun and runs on glibc-based Linux. Session
supervision requires a kernel with pidfd signaling (introduced in Linux 5.1).
For manual source runs, use Bun.

1. In Dispatch, open **Settings → Runners → Add runner**, copy the
   installation command, and run it on the Linux host. The installer
   configures the installing user as the workload account and adds
   `dispatch-runner` to `/usr/local/bin`.
2. Run the separate connect command on Linux. Copy the service URL from Dispatch Settings:

   ```sh
   sudo dispatch-runner connect 'https://dispatch.example'
   ```

   Keep the full URL when copying. For a private certificate it includes a
   fingerprint. Open the approval link printed by the runner and enter its code. The installed command enables
   and starts the service once enrollment succeeds. Wait for **Online** in
   Settings.

3. Select the runner in **Settings → Runners**. Under **Agent engines**, choose **Install** for
   the engine you want, then **Sign in** for Codex or Claude. The runner uses its
   bundled package manager and installs any required Node runtime under
   `~/.local` in the workload user’s home. Credentials
   belong to that runner's workload account.
4. In **Create Agent**, choose the runner. A Dispatch project can supply the
   repository. Select a base branch for a new worktree, use an existing branch,
   or clear the repository for a scratch session. The runner creates the
   session directory and removes it when the agent is archived.

The copied command is one line. Over the HTTPS runner listener it is:

```sh
curl -fsSk --pinnedpubkey 'sha256//<key hash>' https://<host>:<port>/install | sudo bash
```

curl accepts only the listener key named by the pin, so the script it fetches
comes from this controller. When runner enrollment is disabled, Settings
copies `curl -fsSL http://<dispatch origin>/api/v1/runner-artifacts/install | sudo bash`
instead. The pin changes when the controller reissues its listener
certificate, so copy the command again rather than reusing an old one.

The script downloads the bootstrap and runner archive from the controller
for its own build revision. Over the listener, every download trusts only
the runner CA that the pinned script carries. For a release build, the
script verifies the bootstrap's signed build provenance against
`selfcontained/dispatch/.github/workflows/release.yml` before running it.
The installer verifies `dispatch-server.tar.gz` with the same policy and
extracts the Linux binary for the host's architecture and release tag. The
published `.sigstore.json` sidecars carry the attestations. The installer
accepts `--source URL` for the controller's revision-specific artifact
endpoint and `--cacert FILE` for an HTTPS source; the script supplies them.

To pass installer options, end the command with `| sudo bash -s -- OPTIONS`.
If the controller serves a dev build, the script refuses and prints the same
command with `-s -- --allow-unverified-dev-build`. Dev builds use SHA-256
checks for the bootstrap and archive instead of release attestations. When
invoking the installer directly, the dev flag requires both `--source URL`
and `--sha256 HEX` for the archive digest.

For a manual installation, set `tag` to the exact published release:

```sh
(
  set -e
  tag=vX.Y.Z
  dir=$(mktemp -d)
  trap 'rm -rf -- "$dir"' EXIT
  base="https://github.com/selfcontained/dispatch/releases/download/$tag"
  curl -qfsSL --proto '=https' --proto-redir '=https' "$base/install-dispatch-runner.sh" -o "$dir/install.sh"
  curl -qfsSL --proto '=https' --proto-redir '=https' "$base/install-dispatch-runner.sh.sigstore.json" -o "$dir/install.json"
  gh attestation verify "$dir/install.sh" --hostname github.com \
    --bundle "$dir/install.json" --repo selfcontained/dispatch \
    --signer-workflow selfcontained/dispatch/.github/workflows/release.yml
  sudo bash "$dir/install.sh" install --tag "$tag"
)
```

The service runs the supervisor as root. Sessions run as the non-root user who
invokes `sudo`, with their home, login profile, `~/.dispatch/env`, and supplementary
groups. To select another existing account, end the copied command with
`| sudo bash -s -- --user USER`. Use `| sudo bash -s -- --dedicated-user` to
create the non-login `dispatch-runner` account with home at `/var/lib/dispatch-runner/home`. The operator provisions
the dedicated account’s tools and access. Updates keep the configured account.
The supervisor keeps runner state under `/var/lib/dispatch-runner/runner`.
The settings and private enrollment key
under `/etc/dispatch-runner` are root-only. The CA certificate is readable
by the workload for its scoped Dispatch requests.
The service is enabled at boot and the supervisor reconnects to Dispatch.
The managed service supervises connections. Its systemd unit signals only
the runner daemon on stop or restart. Active agent hosts can keep working
during that interval, and the next daemon reattaches to them. To shut down
all work on a machine, stop the agents in Dispatch while the runner is online,
then stop the unit. A machine reboot ends those processes. The updater still
checks the whole service cgroup and defers while workload processes remain.

Inspect startup logs with `sudo journalctl -u dispatch-runner.service`.
For custom engine install paths, edit the `bins` object in
`/etc/dispatch-runner/runner.json` as root and restart the service while idle.

## Private GitHub repositories

In **Settings → Runners**, select the runner and choose **Sign in to GitHub**.
Open GitHub in your browser and enter the code shown for that runner. Once
GitHub approves, the runner shows the account name and configures Git to use
that login for HTTPS. The runner needs GitHub CLI at `/usr/bin/gh`.

Every agent using that runner’s workload account gets the account’s repository
access. The CLI stores the credential on that machine. Choose **Sign out** in
the runner details to remove the login there. To revoke the authorization at
GitHub, use your GitHub account settings.

In **Create Agent**, select the runner to search its repositories or open a PR
branch. A public HTTPS URL or an empty session folder works without signing in.

## Update or recover

When **Health** shows **Update available** in the runner's Settings, copy its
update command and run it on the Linux host. It updates the existing managed
installation to the controller's build and keeps its enrollment and workload
account. A successful update also refreshes
`/opt/dispatch-runner/install-dispatch-runner.sh` and the `dispatch-runner`
command from the verified archive. Running it again on the same build exits
successfully without restarting the service. Exit status 75 means the update
was deferred while agents were working; run it again once they finish.

For a manual update from GitHub, run the installed updater with the exact
target release tag. The tag must have published Linux build provenance.

```sh
sudo /opt/dispatch-runner/install-dispatch-runner.sh update --tag vX.Y.Z
```

The updater stages and verifies the complete archive before it makes service
changes. On the managed systemd unit, compatible updates keep open, idle agents
running and restart the supervisor. Dispatch reconnects to the existing host
processes. You can continue the same conversation in its checkout.
The updater briefly freezes the service and checks the recorded Linux process
identities. It uses Python 3 for this check when workload processes are present.
An active turn, an unrelated runner operation, an incompatible release, or a
custom stop policy that could terminate agents defers the update with exit 75.
Retry after the reported activity finishes.

The updater retains the previous executable through startup and restores it
if the replacement fails to start. Settings shows **Online** after reconnection.
Enrollment, settings, workspace bindings, and managed checkouts are retained.
Updating before connecting keeps the service stopped.

If an update was interrupted, run:

```sh
sudo /opt/dispatch-runner/install-dispatch-runner.sh recover
```

Recovery can also defer while a turn or runner operation is active. It restores
the previous executable when a replacement is pending, or starts the installed
executable otherwise.

## Validate installer changes

Run `bash scripts/remote-runner/test-installer.sh` from the worktree root.
The fixtures use a temporary service state, synthetic signatures, and fake
systemd commands. They cover retrying installation before and after connect,
asset verification, both Linux architectures, busy-session deferral,
replacement, and recovery.
