# Remote runners in Dispatch

Start here when picking up the prototype. The branch `prototype/remote-runner` contains the Dispatch implementation, regression tests and design notes. The tested implementation is `cffe980f`, based on Dispatch main `65eefba8`. Read [setup and wire traces](remote-runner-prototype.md) for the current manual enrollment and launch procedure. The design below describes the next product milestone.

## First hour on another host

1. Check out the branch and install the locked dependencies with `pnpm install --frozen-lockfile` (pnpm 9.15.9).
2. Run `pnpm run check` from the root. From `apps/server`, run `pnpm exec vitest run test/acp-host.test.ts test/remote-runner-startup.test.ts`.
3. Follow the prototype setup using Bun 1.4.2 and the Linux compile target matching the execution host. Supply an isolated Dispatch instance, one test CA, one manually approved runner certificate, a pre-provisioned guest checkout and a non-root workload account. Supply an HTTPS MCP origin reachable from the runner. Keep the enrollment private key outside the workload account.
4. Launch from Create Agent using the approved runner workspace locator. Start with the deterministic fixture at `apps/server/test/helpers/remote-acp-fixture.ts`. For Codex, install the complete published distribution, including its Code Mode companion. The [offline preflight](../../scripts/remote-runner/codex-offline-preflight.sh) takes the pinned Codex 0.167.1 Linux x86-64 package tarball as its sole argument and runs on Linux with Docker. It uses no account or provider. Its container image supplies the script interpreter; the verified compiled runner used Bun 1.4.2.

## Acceptance evidence at handoff

| Run                                          | Observed result                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dispatch on macOS and a runner in ARM64 Lima | A released OpenCode CLI read a guest-only marker and posted it through Dispatch MCP. Separate tests exercised permission denial, cancellation, local launch regression, service restart, a broken transport and a lost prompt acknowledgement. A same-ID retry invoked the deterministic provider once.                                                             |
| Dispatch on macOS and Cloudy Linux x86-64    | A real ChatGPT-authenticated Codex turn on the canonical cffe980f runner read a fresh guest marker and posted it once through product MCP. The journal recorded one terminal result. The temporary login was removed. The in-flight reconnect proof used a deterministic engine on hardened revision 1ec3b7b1.                                                      |
| Privilege boundary                           | The final runner validates the kernel-reported workload identity before enrollment. The live workload ran non-root with no supplementary groups. The signed-in test used the existing full-access agent mode inside an isolated container. Codex modes that require nested bubblewrap user namespaces need separate proof.                                          |
| Second service                               | A scoped local Hangar Worker used the same cffe980f ARM64 binary. Its adapter replayed the journal after disconnect and the product API served one completed answer from stored data with both transports closed. One pre-provisioned workspace, deterministic engine, no product MCP call or permission prompt. The proof fixture lives in Hangar commit ac4f6d74. |

The canonical Linux ARM64 runner SHA-256 was `40c85e711f1e916edf7f78d3b48eb2e52a6d66ca73d194c4fb8f5fa3495ab019`. The x86-64 runner SHA-256 was `450b9418d06efb53e8ede22ab5602dbb7fce2e00f5dd13e24facacfdcf015848`. These identify tested artifacts; independent rebuilds can differ.

## First product milestone

**One Dispatch instance can run a local agent and agents on two named remote runners at the same time.** Start in `apps/server/src/agents/remote/{service,runner,protocol}.ts`. Trace placement through the manager, workspace target, and ACP runtime. The prototype configures one registration and uses a runner locator in the existing cwd field.

1. Model runner registrations and workspace handles explicitly. Persist enrollment, revocation and last reported capabilities. Bind every command to its registration and workspace. Support certificate renewal and loss of a runner connection while local agents continue operating.
2. Add pairing, runner status and workspace selection to the usual Dispatch launch flow. Preserve the local default. Show pending permission, stopped, disconnected and recovered states accurately. Test two runners exposing identically named workspaces.
3. Persist enough operation and replay state to recover from service or runner restart. Exercise a crash between receiving an event and storing it, duplicate command delivery, journal replacement, host death and independent revocation. Verify one provider invocation and one visible completion where a receipt establishes acceptance; represent uncertain outcomes explicitly.
4. Acceptance run: start a local agent and two remote agents, disconnect one runner mid-turn, continue work on the other two, reconnect the first, then revoke it. Confirm correct output ownership throughout and no cross-runner workspace access.

## Keep the execution contract portable

Start with a package boundary in Dispatch. Keep registration identity, workspace binding, process supervision, permissions, operation receipts and stream replay independent of the Dispatch server. Keep boards, messages, personas and UI in Dispatch. Let service and runner negotiate supported operations. The Hangar experiment identified three specific changes:

- Accept opaque IDs and distinguish spawn receipt, ready session, accepted prompt and completed turn. Hangar needed an alias to satisfy the current Dispatch agent-ID format.
- Make service-owned MCP optional and independently scoped. The Hangar proof needed a dummy HTTPS URL and token even for an engine that never called a product tool.
- Specify stream identity, contiguous sequence, replay boundary, persistence and acknowledgement. Hangar has its own activity cursor. Advancing a cursor before its payload is durably recorded can lose output.

Keep a small independent consumer test that imports no Dispatch server code. Run the scoped Hangar proof when changing wire semantics. Treat remote file publishing, Git/worktree management and preview relaying as separate feature slices. For previews, the runner can report an approved workspace-local endpoint under an opaque ID. Dispatch owns browser URLs, access and revocation. A later acceptance test should open two previews on the same guest port, exercise live reload, and disconnect either runner independently.
