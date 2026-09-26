# OpenCode through ACP

Dispatch launches the installed OpenCode CLI with `opencode acp`. Install it with
`npm i -g opencode-ai` and configure a provider in OpenCode. The binary is found
on PATH or in common installation directories (including `~/.opencode/bin`).
`DISPATCH_OPENCODE_BIN` overrides it with an absolute executable path.

Enable OpenCode in Settings → Agent Types if your saved enabled list excludes it.
The first launch uses OpenCode's configured default model. Once ACP reports its
model options, Dispatch learns and persists that catalog for model pickers and
future launches. Model IDs are provider-qualified, for example
`ollama/qwen3-coder:30b`; availability depends on your provider configuration.
No machine-specific model list is shipped in Dispatch.

OpenCode receives Dispatch guidance and persona rules through a private native
instructions file. The host merges it into `OPENCODE_CONFIG_CONTENT`, preserving
existing configuration and instruction paths, on both launch and resume.
HTTP MCP connects the session to Dispatch. Native ACP
provides streamed text, tool calls, model/mode selection, cancellation, and resume.
Restricted sessions route requested permissions to the user; full-access sessions
automatically approve ACP permission requests. OpenCode's own agent configuration
still applies; build/plan modes are not filesystem sandboxes.

## Version validation

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
