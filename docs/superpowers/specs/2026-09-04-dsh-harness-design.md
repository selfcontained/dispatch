# dsh: a stream-native harness for Dispatch

Status: approved direction, prototype scope. Written 2026-09-04.

## Why

Every harness Dispatch drives today is a closed loop. Claude Code, Codex, Cursor
and OpenCode each own their agent loop, so Dispatch integrates from the outside:
the tmux pane is the agent, messages are pasted into the pane, tokens are scraped
from log files on disk, and status depends on the agent remembering to call
`dispatch_event`. That is a lot of scaffolding around something Dispatch cannot
see into.

DeepSeek Harness (dsh, `deepseek-ai/deepseek-harness`, MIT, TypeScript) is an
open agent runtime built as a plugin tree. It exposes the loop: a durable session
event log, a persona seam, tool restriction, an MCP client, and two stdio
protocols for driving it from another process. Building a Dispatch profile on top
of it turns every workaround above into a structural feature, and gives Dispatch a
model-agnostic agent type (DeepSeek, OpenAI, Anthropic, any OpenAI-compatible
endpoint) whose UI is Dispatch itself.

This spec covers the prototype: enough to launch a dsh agent from the Dispatch UI,
watch it work in the Chat tab, talk to it, and run a persona on it. It names what
the prototype leaves out so scope is a decision, not an accident.

## Verified facts the design rests on

Probed on 2026-09-04 against `@deepseek-ai/dsh@0.1.2-rc.1` with
`@agentclientprotocol/sdk@1.4.0`. The probe script is throwaway and lives outside
the repo.

- `dsh --profile acp` speaks Agent Client Protocol v1 over stdio. `initialize`
  advertises HTTP MCP support and session `close`, `list`, `resume`.
- `session/new` accepts `cwd` and an `mcpServers` list. A streamable HTTP MCP
  server with an `Authorization: Bearer` header connects, initializes, and has
  its tools listed before the session is published. A failed MCP connection
  fails the session, loudly.
- `session/new` returns `configOptions`: a grouped model select drawn from the
  live LLM catalog, plus a reasoning-effort select. `session/set_config_option`
  changes either per session.
- A `--patch <file>` overlay on the CLI replaces any config row by id. Adding
  provider routes to the `llm-pi-ai` row made the whole OpenAI catalog appear in
  the model select with no key present. Replacing the `system-prompt` row's
  `persona` field replaces the deployment persona.
- `session/prompt` without a credential for the selected route fails with a
  clear `-32603` error naming the env var. Keys are read from the launching
  environment or dsh's credential store.
- `session/update` kinds that matter: `agent_message_chunk`,
  `agent_thought_chunk`, `tool_call` (with `kind`, `status`, `title`,
  `locations`, and `content` that can be `content`, `diff`, or `terminal`),
  `tool_call_update`, `usage_update` (input, output, thought, cache read, cache
  write tokens, context size), `config_option_update`.
- `session/request_permission` is a client-answered request with allow and
  reject options. The acp profile ships `approval: ask` and
  `sandbox: workspace-write` by default, switchable to `danger-full-access`
  with `DSH_PERMISSION_MODE`.
- dsh has no terminal UI. Its shipped applications are web, headless, sdk, and
  acp.

## Decisions

**ACP over SDK.** dsh's own SDK protocol streams every durable session event but
has no per-session close, no cancel, no permission prompts on the wire, and no
per-session MCP attach. ACP has all four, and it is a standard: the same client
driver can later drive Zed's Claude Code and Codex ACP adapters. The prototype
gives up dsh-specific presentation cards for that, which is the right trade.

**One process per agent.** ACP multiplexes sessions on one connection, but one
`dsh` process per Dispatch agent keeps isolation, cwd, environment, and teardown
identical to how every other agent type behaves. Sharing comes later if it earns
it.

**Dispatch is the UI.** No dsh web client is embedded or themed. The Chat tab
renders the stream. The Console tab keeps a plain login shell in the worktree,
which the `terminal` agent type already provides.

**Minimal seam, not the full refactor.** The prototype adds dsh beside the
existing per-type branches. It introduces one new module boundary, the stream
driver, and touches the existing branch sites only where dsh must diverge. A full
harness-adapter extraction is a separate decision after the prototype proves
itself.

**Match Claude's permission posture.** Dispatch launches Claude Code with the
Dispatch MCP and no approval gating in the pane. The prototype launches dsh with
`DSH_PERMISSION_MODE=danger-full-access` so `request_permission` never fires.
Routing permission prompts into the Chat tab as an approval card is a follow-up.

## Architecture

```
Dispatch server                                   dsh (child process per agent)
─────────────────────────────                     ─────────────────────────────
AgentManager.createAgent(type="dsh")
  └─ setup script in tmux (worktree, deps, hooks)
       └─ exec login shell        ◄── Console tab
  └─ completeSetup()
       └─ DshDriver.start(agent)  ──spawn──►  dsh --profile acp --patch <agent overlay>
            initialize                          │
            session/new { cwd, mcpServers:      │  mcp-client ──HTTP+bearer──► /api/mcp/<agentId>
              [dispatch HTTP + bearer] }        │  (dispatch_event, chat, pins, repo tools)
            prompt / cancel / close             │
            ◄── session/update ─────────────────┘
       └─ StreamRecorder ─► agent_stream_events ─► Chat feed (assistant text, activity cards)
       └─ StatusDeriver   ─► agent status (working / idle)
       └─ UsageRecorder   ─► agent_token_usage
```

### Components

**`packages/shared/src/agent-types.ts`** gains `"dsh"` in `AGENT_TYPES` and
`CLI_AGENT_TYPES`. dsh is eligible for jobs, reviews, and personas from day one.
`PLUGIN_AGENT_TYPES` stays `claude` and `codex`; dsh needs no plugin install.

**`apps/server/src/agents/dsh/`** is the new module. Nothing outside it imports
the ACP SDK.

- `driver.ts`: `DshDriver` owns one child process per agent. `start(agent)`
  spawns `dsh --profile acp --patch <overlay>` with `cwd` set to the agent's
  effective cwd, runs `initialize`, then `session/new` (or `session/resume` when
  the agent record already holds a dsh session id) with Dispatch's HTTP MCP
  server attached. `prompt(agentId, text)`, `cancel(agentId)`,
  `stop(agentId)`, and `setModel(agentId, provider, model)` map one-to-one onto
  ACP calls. It emits typed events (`update`, `status`, `exit`) that the
  recorders below consume. Teardown walks stdin EOF, SIGTERM, SIGKILL, and
  records the exit for `readExitInfo` parity.
- `overlay.ts`: builds the per-agent patch file from Dispatch state. Rows it
  writes: `llm-pi-ai` provider routes from the dsh model catalog; `system-prompt`
  persona text, which is the launch guidance, plus the persona brief or active
  personality when present; `agent-default-model` from the chosen model. The
  file lives under the agent's worktree metadata dir, never in the repo tree.
- `stream-recorder.ts`: folds `session/update` into `agent_stream_events` rows.
  Assistant chunks accumulate into one row per message until the next non-chunk
  update or turn end. Tool calls get one row keyed by `toolCallId` and are
  updated in place on `tool_call_update`. Thoughts are stored but collapsed by
  default.
- `status-deriver.ts`: a prompt in flight is `working`; settled is `idle`.
  `done`, `blocked`, and `waiting_user` still come from the agent calling
  `dispatch_event`, because those are judgments only the agent can make. The
  activity monitor's pane-digest heuristic is skipped for dsh agents.
- `usage-recorder.ts`: `usage_update` carries cumulative totals. The recorder
  upserts `agent_token_usage` keyed by agent, dsh session id, and the model
  named by the latest `config_option_update`. This replaces the token harvester
  for dsh; the harvester's dispatch returns early for the type.
- Model catalog: a `dsh` entry in the existing `AGENT_MODEL_OPTIONS` map in
  `apps/server/src/shared/agent-models.ts`. Static for the prototype: DeepSeek
  V4 Flash and Pro, and the OpenAI GPT-5 family the probe listed. Each id is
  `provider/model` (for example `deepseek-official/deepseek-v4-flash`) so the
  agent record's existing `model` string carries both halves unchanged, and
  `overlay.ts` splits it.

**`apps/server/src/agents/tmux/command-builder.ts`** returns the `terminal`
login-shell command for dsh. The setup script runs unchanged, so worktree
creation, dependency install, local config copy, and lifecycle hooks all apply.

**`apps/server/src/agents/manager.ts`** calls `DshDriver.start` from
`completeSetup` when the agent type is dsh, `DshDriver.stop` from stop and
archive paths, and stores the dsh session id in the existing `cliSessionId`
column. Restart resumes rather than recreates.

**`apps/server/src/server/agent-prompts.ts`** gains a dsh branch in
`enqueueAgentPrompt`: the prompt text goes to `DshDriver.prompt` instead of the
pane. Every existing caller keeps working: chat user messages, cross-agent
messages, quick prompts, shortcut pins, and persona launch context all flow
through this one function already. The cross-agent message envelope is kept
verbatim for the prototype so the agent's instructions about `replyTarget`
still apply.

**`apps/server/src/chat/feed.ts`** reads `agent_stream_events` as a sixth feed
source and emits two new `ChatFeedEntry` variants defined in
`packages/shared/src/chat-types.ts`:

- `ChatAssistantEntry { type: "assistant"; id; text; at; streaming: boolean }`
- `ChatActivityEntry { type: "activity"; id; toolKind; title; status;
locations; diff?: { path; oldText; newText }; terminalOutput?: string; at }`

Assistant entries render with the same markdown block the agent chat message
uses. Activity entries render as compact rows with the existing status colours
and open inline for diffs and terminal output. The Chat tab is the default tab
for dsh agents.

**`apps/web`** adds the dsh icon and label to `agent-type-icon.tsx`,
`agent-type-select.tsx`, and `agent-type-settings.tsx`, the model options to
the picker, and the two new entry renderers to the chat feed. All styling uses
the existing theme tokens; nothing dsh-specific is introduced.

**`apps/server/src/config.ts`** gains `dshBin` (default `dsh` on PATH) and
`dshHome` (default `~/.dispatch/dsh`). On first launch Dispatch initializes the
`acp` profile under that home so dsh's own `~/.dsh` is never touched.

### Data

Migration `agent_stream_events(id, agent_id, seq, kind, payload jsonb,
created_at)` with an index on `(agent_id, seq)`. Rows are append-only except
tool-call updates, which rewrite the row for their `toolCallId`. The feed reads
the last N by seq. Retention follows the agent: archive keeps, delete cascades.

### Personas

`dispatch_launch_persona` with `agentType: "dsh"` follows the normal launch path.
The assembled persona prompt goes into the overlay's `system-prompt.persona`
field instead of `--append-system-prompt`, so the 8KB cap does not apply. The
review tool whitelist stays enforced by the Dispatch MCP server exactly as
today, so the reviewer contract (`working`, `dispatch_review_submit` once,
`done`) is unchanged. Native `toolFilter` restriction is a follow-up.

### Credentials

The driver passes `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY`
through from the server environment when set. A missing key surfaces as the
`-32603` error text in the Chat tab as a status entry, not as a silent stall.
A Dispatch settings page for keys is a follow-up.

### Error handling

- dsh exits unexpectedly: the driver records the exit, marks the agent `blocked`
  with the last stderr line, and leaves the tmux shell up so the user can
  inspect. Restart re-spawns and resumes the session.
- MCP attach fails at `session/new`: the launch fails with the ACP error text;
  the agent lands in the same failed-setup state a bad CLI command would.
- Prompt rejected (`-32603`): recorded as a status entry with the message; the
  agent returns to `idle`.
- Cancel: the stop button on a dsh agent calls `session/cancel` first, then
  `close` on a hard stop.

### Testing

- Unit (vitest, `apps/server/test`): overlay builder output for each input
  combination; stream recorder folding of chunk sequences and tool call
  updates; usage recorder upsert math; status derivation; feed mapping to
  entries. The driver is tested against a fake ACP agent built with the SDK's
  `AgentSideConnection` over in-memory streams, covering initialize, new,
  resume, prompt, cancel, close, and process-exit paths. No test spawns the
  real dsh binary.
- E2E (Playwright): launch a dsh agent against a fake `dsh` shim on PATH that
  speaks ACP and scripts a short turn with one tool call. Assert the type
  appears in the picker, the Chat tab shows an assistant entry and an activity
  row, status flips working then idle, and a chat message from the user
  reaches the shim as a prompt.
- Manual: one live turn against DeepSeek or OpenAI with a real key before
  calling the prototype done.

## Out of scope for the prototype

Named so they are chosen later, not forgotten.

- Unread and read receipts for stream entries. The sidebar badge and
  `markRead` key on `agent_chat_messages`; a dsh agent's assistant posts do
  not light the badge or advance the read marker. Needs a per-agent read
  watermark over `agent_stream_events` (raised by the frontend UX review).

- Permission prompts as approval cards in the Chat tab.
- Native persona `toolFilter` and `complete` mode through agent presets.
- Agent Teams mailbox bridged to Dispatch messages.
- Dynamic model catalog read from `session/new` at settings time.
- Credential entry UI. ChatGPT-plan OAuth.
- A themed deep link into dsh's trajectory view for fork and replay.
- The full harness-adapter extraction across all agent types.
- Shared dsh process across agents.
- Image prompts.
