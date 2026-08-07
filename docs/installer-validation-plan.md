# Git-free install results

| Area             | Scenario                                     | Result  | Evidence                                                                                                                                                           |
| ---------------- | -------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime          | Embedded version/SHA without Git             | Pass    | Compiled Linux/macOS binaries served release info from no-checkout roots with `PATH=/bin`.                                                                         |
| Runtime          | Verified atomic activation                   | Pass    | Focused test replaces live runtime, creates `.previous`, writes a candidate, and requests restart.                                                                 |
| Runtime          | Bad checksum                                 | Pass    | Focused test fails before restart and preserves old runtime.                                                                                                       |
| Runtime          | Duplicate or symlink tar member              | Pass    | Focused tests reject both before activation; live runtime is unchanged.                                                                                            |
| Runtime          | Candidate promotion                          | Pass    | Only the new binary's matching candidate can write `release.json`; mismatches remain pending.                                                                      |
| Fresh install    | Linux, supplied database URL                 | Pass    | User systemd unit, fixed runtime, healthy endpoint, initialized release/migration state.                                                                           |
| Fresh install    | Published `v0.32.0` prerelease               | Pass    | Fresh Linux VM install from the published tag: systemd active, `/api/v1/health` OK, fixed runtime and `release.json` at `v0.32.0`.                                 |
| Fresh install    | Published `v0.32.0` prerelease (macOS)       | Pass    | Fresh macOS VM install from the published tag: LaunchAgent healthy, fixed runtime, initialized release state, and configured log file.                             |
| Fresh install    | Linux, local PostgreSQL                      | Pass    | Installer creates generated role/database through peer-authenticated Postgres and reaches health.                                                                  |
| Fresh install    | macOS, supplied database URL                 | Pass    | LaunchAgent, fixed runtime, healthy endpoint, initialized release/migration state.                                                                                 |
| Fresh install    | Invalid artifact                             | Pass    | Missing expected binary leaves no runtime, service definition, or active release record.                                                                           |
| Existing install | Linux versioned systemd `ExecStart`          | Pass    | Versioned path ran, then changed to fixed executable with `.previous`; health passed after each restart.                                                           |
| Existing install | Published `v0.31.5 → v0.32.0` update         | Pass    | Linux VM service stayed healthy after the published-artifact update; fixed entrypoint remained and `.previous` was created.                                        |
| Existing install | Published `v0.31.5 → v0.32.0` update (macOS) | Pass    | macOS LaunchAgent stayed healthy; fixed runtime remained and `.previous` was created.                                                                              |
| Existing install | macOS versioned LaunchAgent                  | Pass    | Versioned path ran, then changed to fixed executable with `.previous`; health passed after each restart.                                                           |
| Existing install | macOS legacy wrapper bridge                  | Pass    | Legacy plist survived target checkout; bridge wrapper selected the exact target despite older tar mtime, then fixed-path relaunch succeeded after wrapper removal. |
| Existing install | No supported service definition              | Guarded | Manifest and agent prompt require report-only behavior; they forbid creating or inventing a service. A live agent run remains pending.                             |
| Existing install | System-owned service definition              | Guarded | Manifest and agent prompt forbid privilege escalation or editing a system-owned definition; a live agent run remains pending.                                      |
| Repository       | Types, unit suite, browser E2E               | Pass    | `pnpm run check`, `pnpm run test`, and `pnpm run test:e2e`.                                                                                                        |

The release manifest makes the fixed-runtime migration required. The fresh
installer intentionally refuses existing installations; those two pending rows
are safety tests for the assisted updater, not alternate installer modes.
