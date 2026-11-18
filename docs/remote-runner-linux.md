# Install a managed Dispatch runner on Linux

Use a supported Dispatch release and a Linux x86-64 or ARM64 host with systemd,
the unified cgroup v2 hierarchy, and systemd's `freeze` and `thaw` commands.
Install Bash, curl, tar, util-linux (including `/usr/bin/setpriv` and `flock`),
`useradd`, GNU coreutils, and a GitHub CLI with `gh attestation verify --bundle`.
GitHub CLI verifies the published bundles without a GitHub login.
The runner must be able to reach the HTTPS address in the pairing command.

1. Install the engines you plan to use according to their Linux instructions.
   The default runner configuration looks for `claude`, `codex`, and `opencode`
   under `/usr/local/bin`. Install any companion binaries the engine requires.
2. In Dispatch, open **Settings → Connections → Remote runners**, name the
   runner, and choose **Pair runner**. Run the displayed installation command
   on Linux with sudo access. The code is single-use and expires after ten
   minutes. If it expires during setup, request a fresh code.
3. Wait for **Online** in Settings. If the selected engine needs credentials,
   sign in as the workload account using its managed home. For example, run
   `sudo -u dispatch-runner -H /usr/local/bin/codex login` if you use Codex.
4. Choose the runner when launching a session in Dispatch. The runner allocates
   the managed session directory. The reserved `@session` placement is supplied
   by the runner. Installation requires no checkout or workspace path.

The command downloads the bootstrap from the selected GitHub release and
verifies its signed build provenance against
`selfcontained/dispatch/.github/workflows/release.yml` before passing it to
sudo. The installer verifies the existing `dispatch-server.tar.gz` with the
same policy and extracts the Linux binary for the host's architecture and
release tag. The published `.sigstore.json` sidecars carry the attestations.
This path requires a release that includes those assets.

The service runs the supervisor as root and starts engine processes as the
dedicated non-login `dispatch-runner` account. The workload account owns
`/var/lib/dispatch-runner/home`. The supervisor keeps its state under
`/var/lib/dispatch-runner/runner`. The settings and private enrollment key
under `/etc/dispatch-runner` are root-only. The CA certificate is readable
by the workload for its scoped Dispatch requests.
The service is enabled at boot and the supervisor reconnects to Dispatch.
Inspect startup logs with `sudo journalctl -u dispatch-runner.service`.
For custom engine install paths, edit the `bins` object in
`/etc/dispatch-runner/runner.json` as root and restart the service while idle.

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
Updates preserve the enrollment, settings, and workload state.

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
systemd commands. They cover enrollment retry, asset verification, both Linux
architectures, busy-session deferral, replacement, and recovery.
