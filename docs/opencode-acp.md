# OpenCode through ACP

Dispatch launches the installed OpenCode CLI with `opencode acp`. Install it with
`npm i -g @opencode/cli` and configure a provider in OpenCode. The binary is found
on PATH or in common installation directories (including `~/.opencode/bin`).
`DISPATCH_OPENCODE_BIN` overrides it with an absolute executable path.

Enable OpenCode in Settings → Agent Types if your saved enabled list excludes it.
The first launch uses OpenCode's configured default model. Once ACP reports its
model options, Dispatch learns and persists that catalog for model pickers and
future launches. Model IDs are provider-qualified, for example
`ollama/qwen3-coder:30b`; availability depends on your provider configuration.
No machine-specific model list is shipped in Dispatch.

When you pin a model, startup requires OpenCode to report that selection. If
OpenCode cannot resume a saved session, Dispatch reports the failure and keeps
its session ID for retry. Create a new agent if you want a fresh conversation.

OpenCode receives Dispatch guidance and persona rules through a private native
instructions file. The host merges it into `OPENCODE_CONFIG_CONTENT`, preserving
existing configuration and instruction paths, on both launch and resume.
HTTP MCP connects the session to Dispatch. Native ACP
provides streamed text, tool calls, model/mode selection, cancellation, and resume.
OpenCode V2 always uses full access. Dispatch normalizes OpenCode agents, templates,
jobs and task launches to full access, including existing saved restricted settings.
The UI shows full access and offers no restricted option. ACP permission requests
are automatically approved using a one-time option; native effective deny rules
still block operations. The old `OPENCODE_PERMISSION` wildcard is retired. OpenCode's own agent configuration
still applies; build/plan modes are not filesystem sandboxes.

## V2 installation and update channels

Validated against `@opencode/cli` 2.3.2. The official Homebrew V2 formula is
`anomalyco/tap/opencode-v2`. The old `anomalyco/tap/opencode` formula and
`opencode-ai` npm package are V1 channels. Both Homebrew formulas install the
same `opencode` command and conflict; an upgrade of the V1 formula is not a
migration to V2. Back up configuration and data before removing a package or
converting configuration. Never overwrite an existing installation automatically.

Dispatch keeps PATH/explicit-binary selection authoritative. Update reporting
includes the selected path, resolved path, verified package channel, update
command and V1 migration warning. A legacy installation stays on its verified
legacy update channel; Dispatch never runs a cross-channel upgrade. Version-pinned
Homebrew paths remain manual. Ownership and package identity checks still apply.
Unknown OpenCode installations do not borrow npm's V2 latest-version metadata.

V2's default Code Mode puts MCP tools in its system catalog as
`tools.dispatch.<tool>`, called through `execute`; they are not ordinary direct
model tools. No permission change is needed to expose them. The isolated fixture
suite verifies an authenticated HTTP MCP call through this default catalog.

## Isolated regression suite

Run from the repository root with Bun and an explicitly selected V2 binary:

```sh
bun scripts/opencode-v2-smoke.mjs /absolute/path/to/v2/opencode ask
bun scripts/opencode-v2-smoke.mjs /absolute/path/to/v2/opencode deny
# Optional final argument: installed V1 binary, invoked only with disposable HOME.
bun scripts/opencode-v2-smoke.mjs /absolute/path/to/v2/opencode ask /absolute/path/to/v1/opencode
```

This gated suite uses a deterministic localhost provider, fake provider credentials,
fixture HTTP MCP, and disposable HOME/XDG directories. It never changes the selected
system installation or uses a paid model. It covers full-access native ask and deny,
Code Mode HTTP MCP, instructions, selected model, fresh session/resume and cancellation.
Fixture MCP proves transport/catalog behavior; it is not a paid-model quality test.

Isolated results, November 18, 2026 (V2 2.3.2; V1 1.19.6):

| Flow                                      | Result                                                          |
| ----------------------------------------- | --------------------------------------------------------------- |
| Fresh V2 session and V2 resume            | Passed; same session ID                                         |
| V1 fixture turn, then V2 resume           | Passed; same session ID, separate HOME/XDG                      |
| Model and effort                          | `fixture/coder` and `high` reached localhost provider           |
| Native instructions                       | Dispatch instructions reached provider system messages          |
| Stream, usage, cancellation               | Text chunks, token usage and cancelled stop reason observed     |
| Full-access native ask / effective deny   | Ask auto-approved; deny excluded shell and no command ran       |
| Default Code Mode + fixture HTTP MCP      | Authenticated nested tool call completed                        |
| Default Code Mode + isolated Dispatch MCP | `rename_session` persisted fixture name; `list_agents` returned |

The real Dispatch MCP smoke used the isolated dev database/API and a disposable
agent row, removed afterward. No production server or paid provider was used.

## Rollback

Keep the V1 binary/package version and separate copies of V1 config and data before
switching. Preserve `~/.config/opencode`, `~/.local/share/opencode`, and any custom
XDG/config locations. Do not run V1 against data or native config rewritten by V2.
Rollback means restoring the V1 package and the untouched V1 config/data copies;
retain the V2 data separately so neither history is lost. A selected absolute
`DISPATCH_OPENCODE_BIN` can point back to the preserved V1 binary while restoring
its matching config/data environment. Exact machine switch/rollback commands must
be proposed after merge and require the user's go; this change does not switch the
user's local installation.

Sources: [V1 migration](https://opencode.ai/docs/migrate-v1/),
[V2 MCP](https://opencode.ai/docs/mcp-servers/),
[Homebrew V2 formula](https://github.com/anomalyco/homebrew-tap/blob/master/opencode-v2.rb).

## Historical V1 validation

Upgraded the local Homebrew installation from 1.14.30 to 1.18.32 and retested
native ACP plus the isolated Dispatch stack.

- Missing Ollama models now return an explicit ACP error, which Dispatch displays
  in the failed turn. Version 1.14.30 returned an empty successful turn instead.
- `session/close` now succeeds, followed by a successful `session/resume`.
  The older adapter returned method-not-found for close.
- Existing Dispatch sessions resume on 1.18.32 with the same session ID.
- A real Qwen 3.8 turn completed in 27.1 seconds, returning `OK`, 8,194 input
  tokens, 28 output tokens, and context/cost updates. The browser needed a reload
  to show the settled turn during dev-server activity; the host journal had
  already recorded completion.
- Model and build/plan selection work through session config options.
- The adapter provides a separate `effort` option (category `thought_level`) when
  the selected model has configured variants; Dispatch already supports that category.

Image attachments now travel as native ACP image blocks when the engine advertises
image support, including startup attachments and queued posts. PNG, JPEG, WebP,
and GIF are supported, capped at 10 MiB each and 20 MiB per turn. Oversized or
unavailable images retain their file references. The selected model must support
vision; custom OpenCode model definitions need image input in their modalities.
File references use the attachment owner's directory, including cross-agent posts.

Visible feeds and threads with unfinished turns reconcile every 30 seconds to
recover a missed final stream event; polling stops when the turn settles. Failed
SSE snapshots close the connection so the browser retries and reconciles.

Dispatch's `launch_agent` provides delegated agents with separate visible streams.
Native subagent text is not a Dispatch feature-parity requirement.

Remaining limitations: permissions are not an OS sandbox, and
provider subscription limits are not reported through this integration. The usage
tool now explicitly distinguishes missing subscription limits from session usage. The
advertised model catalog still reflects configuration, not whether an Ollama
model is actually installed. Token/context/cost accuracy depends on the provider.

See the [OpenCode ACP documentation](https://opencode.ai/docs/acp/) and the
[1.18.32 ACP implementation](https://github.com/anomalyco/opencode/tree/v1.18.32/packages/opencode/src/acp).

## Follow-up validation

- Native OpenCode requests to Qwen 3.8 contain an image part and Dispatch rules in
  the system message, with no duplicate rules in the user message.
- A live Qwen 3.8 image-only session (agent-level tools disabled to fit its
  context) correctly identified the red circle and blue square after a follow-up
  clarified that image content accompanies the file reference.
- Dropping final SSE events in Playwright leaves the turn temporarily thinking;
  the feed refresh recovers its settled state without a page reload.
- The local Ollama setup advertises more context than its actual 16K allocation.
  A full OpenCode request with its tool catalog can exceed that allocation;
  configure sufficient model context or reduce the agent's tool set.
- Type checking, the production web build, 162 E2E tests, and 1,678 web unit tests
  pass. Backend tests: 2,912 pass, nine skipped, with the pre-existing duplicate
  `0010` migration-prefix check failing.
