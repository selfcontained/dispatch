# Install a managed Dispatch runner on Linux

Use a supported Dispatch release and a Linux x86-64 or ARM64 host with systemd,
the unified cgroup v2 hierarchy, and systemd's `freeze` and `thaw` commands.
Install Git, procps (ps), findutils, Bash, curl, tar, util-linux (including `/usr/bin/setpriv` and `flock`),
`useradd`, GNU coreutils, and a GitHub CLI with `gh attestation verify --bundle`.
GitHub CLI verifies the published bundles without a GitHub login.
The runner must be able to reach the HTTPS address in the pairing command.

1. In Dispatch, open **Settings → Connections → Remote runners** and run
   the installation command for the available release. The installer
   prepares the workload account and configuration, and adds
   `dispatch-runner` to `/usr/local/bin`.
2. Run the separate connect command on Linux. Copy the service URL from Dispatch Settings:

   ```sh
   sudo dispatch-runner connect 'https://dispatch.example'
   ```

   Keep the full URL when copying. For a private certificate it includes a
   fingerprint. Open the approval link printed by the runner and enter its code. The installed command enables
   and starts the service once enrollment succeeds. Wait for **Online** in
   Settings.

3. Open **Manage engines** on the runner in Dispatch. Choose **Install** for
   the engine you want, then **Sign in** for Codex or Claude. The runner uses
   Node.js and npm from its workload PATH to install engine binaries under
   `/var/lib/dispatch-runner/home/.local/bin`. Install Node.js and npm on
   the Linux host to enable managed engine installs and updates. Credentials
   belong to that runner's workload account.
4. In **Create Agent**, choose the runner. A Dispatch project can supply the
   repository. Select a base branch for a new worktree, use an existing branch,
   or clear the repository for a scratch session. The runner creates the
   session directory and removes it when the agent is archived.

The command downloads the bootstrap from the selected GitHub release and
verifies its signed build provenance against
`selfcontained/dispatch/.github/workflows/release.yml` before passing it to
sudo. The installer verifies the existing `dispatch-server.tar.gz` with the
same policy and extracts the Linux binary for the host's architecture and
release tag. The published `.sigstore.json` sidecars carry the attestations.
This path requires a release that includes those assets.

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

Settings can check availability using
`GET https://api.github.com/repos/selfcontained/dispatch/releases/tags/<tag>`.
The response's `assets[].name` values must include
`install-dispatch-runner.sh`, `install-dispatch-runner.sh.sigstore.json`,
`dispatch-server.tar.gz`, and `dispatch-server.tar.gz.sigstore.json`.
Inspect the exact tag rather than GitHub's latest-release alias so the runner
matches the Dispatch protocol bundled with that release.

The service runs the supervisor as root and starts engine processes as the
dedicated non-login `dispatch-runner` account. The workload account owns
`/var/lib/dispatch-runner/home`. The supervisor keeps its state under
`/var/lib/dispatch-runner/runner`. The settings and private enrollment key
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

For private checkouts, install GitHub CLI at `/usr/bin/gh` on the runner and
sign in once as its workload account. Configure the Git credential helper so
agents can also push over HTTPS from inside their worktrees.

```sh
sudo -u dispatch-runner -H /usr/bin/gh auth login --hostname github.com --git-protocol https --web
sudo -u dispatch-runner -H /usr/bin/gh auth setup-git --hostname github.com
```

Sessions on this runner share that account’s repository access. Choose a
repository in Create Agent as needed. Public HTTPS checkouts and scratch
sessions work without a GitHub login.

## Update or recover

Run the installed updater with the exact target release tag. The tag must
have published Linux build provenance.

```sh
sudo /opt/dispatch-runner/install-dispatch-runner.sh update --tag vX.Y.Z
```

The updater stages and verifies the complete archive before it makes service
changes. It briefly freezes the service cgroup to check for workload processes
and exits with status 75 if the runner is busy. Retry after the sessions have
ended. On an idle runner it retains the previous executable, atomically
replaces the live executable, and checks that the replacement service survives
startup. The runner's **Online** status in Settings confirms reconnection. If
startup fails, the updater restores the previous executable and starts it.
Updates preserve the enrollment, settings, and workload state. Updating before
connect keeps the service stopped.

If an update was interrupted, run:

```sh
sudo /opt/dispatch-runner/install-dispatch-runner.sh recover
```

Recovery can also defer while a workload is active. Once idle, it will restore
the previous executable when a replacement is pending, or start the installed
executable otherwise.

## Validate installer changes

Run `bash scripts/remote-runner/test-installer.sh` from the worktree root.
The fixtures use a temporary service state, synthetic signatures, and fake
systemd commands. They cover retrying installation before and after connect,
asset verification, both Linux architectures, busy-session deferral,
replacement, and recovery.
