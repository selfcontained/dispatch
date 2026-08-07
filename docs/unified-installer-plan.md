# Unified fresh-install script

## Decision

Ship one POSIX-shell installer for fresh Dispatch installations on macOS and
Linux. It installs a verified release artifact, provisions local PostgreSQL by
default, writes the private runtime configuration, and registers a per-user
service appropriate to the platform.

Version one supports **one Dispatch instance per user**. That matches the
current global release/migration stores and fixed update restart labels. The
script rejects an existing Dispatch service or install sentinel rather than
overwriting it. Multiple independently configurable instances are a later,
deliberate design.

The installer is deliberately **not** an existing-install migrator. Existing
checkout-based installs move to the fixed-runtime layout through the required
assisted-update migration. This keeps a fresh-install command from changing a
live service's supervisor, working directory, or configuration unexpectedly.

## User experience

The primary interactive path is one copyable command:

```sh
curl -fsSL https://raw.githubusercontent.com/selfcontained/dispatch/main/bin/install-dispatch.sh | sh
```

The documentation must also offer a download-and-inspect form, since piping a
network response to a shell executes remotely supplied code:

```sh
curl -fL -o install-dispatch.sh \
  https://raw.githubusercontent.com/selfcontained/dispatch/main/bin/install-dispatch.sh
less install-dispatch.sh
sh install-dispatch.sh
```

The version-controlled raw script is the stable bootstrap channel. It selects
the newest non-draft, non-prerelease release through the GitHub Releases API,
states its unauthenticated rate-limit behavior and `GITHUB_TOKEN` override,
and downloads that release tarball by its API-provided asset URL. It must fail
clearly when no stable release exists. A prerelease requires both an explicit
`--tag` and `--allow-prerelease`; it is never selected by default. A future
Dispatch-owned download domain may replace this bootstrap URL, but is not
required for version one.

On a normal interactive run, the script:

1. Detects `Darwin` or `Linux` and the supported architecture.
2. Installs the newest stable release by default, or a supplied stable tag.
   Prereleases require an explicit `--allow-prerelease` opt-in.
3. Checks for a local PostgreSQL server. The default is to create a dedicated
   database, a `dispatch` login role, and a random password; no hand-authored
   env file or SQL is required.
4. Downloads the matching release tarball from GitHub Releases, extracts only
   the expected executable, and verifies it against the artifact's
   `SHA256SUMS.txt` before activation.
5. Installs the executable at its fixed runtime path, defaulting to
   `~/.dispatch/server/dispatch`.
6. Writes private service configuration at `~/.dispatch/server/.env`, with
   mode `0600`, and creates the platform service definition. The installer
   sets an explicit service `PATH` that includes standard system directories
   and expected user tool locations; it does not source shell profiles.
7. Checks that the configured port is available, starts the service, and polls
   `/api/v1/health` at the configured host/port. Only after a healthy response
   does it atomically write the installed release record and seed migration
   state from manifests in the selected artifact.
8. Prints the local URL and the paths it created.

For CI or host automation, the same script supports noninteractive inputs:
`DATABASE_URL`, `--database-url`, `--tag`, `--install-dir`,
`--runtime-path`, `--port`, and `--no-service`. An explicitly supplied
database URL skips local database provisioning.

## Platform behavior

The runtime path is configurable. The default is a convention, not a service
requirement: every generated service definition must use the chosen absolute
path. It does not create a second service identity: with the one-instance
limit, updates continue to restart `dispatch` on Linux and
`com.dispatch.server` on macOS.

The installer config explicitly sets `DISPATCH_SERVER_DIR`,
`DISPATCH_RUNTIME_PATH`, `DISPATCH_RELEASE_STORE_PATH`,
`DISPATCH_APPLIED_MIGRATIONS_STORE_PATH`,
`DISPATCH_RELEASE_CANDIDATE_STORE_PATH`, and
`DISPATCH_ASSISTED_UPDATE_STORE_PATH` to paths under `~/.dispatch`. This
prevents a custom runtime location from accidentally sharing opaque global
state with another future install. A small, tested state-initialization helper
must write the release and migration JSON, rather than reimplementing their
schemas in shell.

| Platform | Service owner | Installed definition                               | Notes                                                                                                                                                    |
| -------- | ------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | current user  | `~/Library/LaunchAgents/com.dispatch.server.plist` | `ProgramArguments` invokes the fixed binary directly; `WorkingDirectory` is `~/.dispatch/server`, allowing `dotenv/config` to load the private `.env`.   |
| Linux    | current user  | `~/.config/systemd/user/dispatch.service`          | Set `WorkingDirectory=~/.dispatch/server` and `EnvironmentFile=~/.dispatch/server/.env`; use `systemctl --user daemon-reload` and enable/start the unit. |

The script does not create a root/system unit. If a Linux host needs Dispatch
to survive logout, it detects and explains the `loginctl enable-linger`
requirement; it does not silently acquire administrator privileges for it.

## Database setup

Database setup is part of the pleasant fresh-install path, while PostgreSQL
package installation remains outside it.

- Probe local peer access, local TCP access, and (only with confirmation)
  Linux `sudo -u postgres` separately. A failed default `psql` connection is
  not enough to conclude the server is unavailable.
- Use generated identifier fragments and a URL/SQL-safe random-password
  alphabet. Do not interpolate prompted values into SQL.
- Create role, database, ownership, and required `public` schema privileges
  in a documented order compatible with supported PostgreSQL versions.
- Generate the password locally; never echo it or place it in the service
  unit/plist.
- If PostgreSQL is missing, stopped, inaccessible, or the user selects an
  existing/managed database, prompt for `DATABASE_URL` instead. Do not require
  PostgreSQL client tools in that branch; Dispatch health validates the URL.
- Never overwrite an existing database or role. On partial provisioning
  failure, retain a clearly reported database/role for retry and provide an
  explicit cleanup command; never automatically drop user data.

The script may create Dispatch's database identity, but should not install a
package manager, PostgreSQL, tmux, or agent CLIs. Its diagnostics should name
the missing prerequisite and the platform-appropriate next command. In
particular, it must warn that Dispatch can start without `tmux` or an enabled
agent CLI, but cannot perform the corresponding agent work until those tools
are installed.

## Security and integrity

- The artifact checksum verifies corruption after download. Because the
  checksum is inside the same release tarball, GitHub Release transport and
  repository access are the trust boundary; it is not an independent signing
  scheme.
- Reject unexpected tar members, duplicate expected members, and
  symlink/non-regular entries when selecting the executable.
- Extract the candidate on the same filesystem as the runtime path, verify it,
  then rename it into place. Verify before `chmod` or activation.
- Keep configuration outside the release artifact, in a user-owned directory
  with restrictive permissions. Never put a database password on a service
  command line or print it to terminal logs.
- On a failed fresh install, remove only installer-created staging files and
  service definitions. Keep the private config and any successfully created
  database/role, report their paths/names, and make retry safe. The install
  sentinel is the Dispatch-owned state directory plus a known Dispatch service
  definition, never an arbitrary user-provided directory alone.

## Relationship to updates and migration

A fresh install starts in the final layout: a stable fixed binary path and a
release-backed state record. Subsequent in-app updates download, verify, and
atomically replace that binary, then restart the service.

Existing installs are different. The required assisted-update migration must
inspect the current supervisor and convert it to the fixed path. When it finds
a supported user systemd unit or LaunchAgent, it can do that work and verify a
restart. When it finds no supported service definition, it must not invent
one: it prepares the fixed runtime and provides the exact new launch path,
leaving the migration pending until an operator updates their custom
supervisor and verifies health.

The transition release must make that migration required in its release
metadata. The old binary cannot promote a candidate record it never wrote, so
the required migration—not normal candidate promotion—owns the first fixed
runtime conversion and records healthy state afterward.

The installer has no `--migrate-existing` mode.

## Packaging and documentation

- Keep the version-controlled bootstrap script testable in the release
  workflow and publish `dispatch-release.tar.gz` as the selected immutable
  release asset. The release process must publish or promote the intended
  production release as non-prerelease before it becomes installer-eligible.
  The bootstrap selects only that stable asset through the Releases API.
- Keep its dependencies to ubiquitous shell tools plus `curl`, `tar`, and
  PostgreSQL client tools only when provisioning or validating a database.
- Release artifacts remain the source for the executable. The installer must
  not clone the repository or install Bun, pnpm, Node, Git, or `gh` to run
  Dispatch.
- Replace the README and site documentation's agent-prompt/manual-install
  path with the script as the recommended new-install route. Retain explicit
  manual and existing-install migration guidance.

## Acceptance criteria

1. A clean macOS host with local PostgreSQL can complete an interactive
   installation without writing SQL or an env file.
2. A clean Linux host with a user systemd session can do the same, including a
   clear authorization prompt when `sudo -u postgres` is needed.
3. A supplied managed-database URL works without local PostgreSQL tools.
4. The chosen custom runtime path is the exact executable path in the created
   LaunchAgent or systemd unit.
5. A failed artifact verification or failed health check does not write
   `release.json` as though the release were live.
6. A regular install has no `.git` checkout and can discover and apply later
   releases.
7. The script refuses to overwrite an existing Dispatch install unless an
   explicit future replacement policy is introduced.
8. Shell compatibility tests cover macOS BSD and Linux GNU variants of `tar`,
   `mktemp`, `sed`, `stat`, and SHA-256 tools (`shasum -a 256` and
   `sha256sum`). The implementation contains no Bash-only syntax when invoked
   through `sh`.
9. Default installation ignores draft and prerelease releases; an intentional
   prerelease install requires both an exact tag and `--allow-prerelease`.

## Remaining implementation choices

- The generated database/role naming convention and recovery output for a
  partial local database-provisioning failure.
- Whether the script invokes Dispatch once to apply schema migrations before
  service registration, or lets the first supervised start perform them.
- The minimal supported PostgreSQL client/version matrix and the exact
  noninteractive flags.
