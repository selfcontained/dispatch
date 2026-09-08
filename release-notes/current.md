## What's Changed
* refactor(web): extract ToggleSettingCard from three settings toggles by @selfcontained in https://github.com/selfcontained/dispatch/pull/1075
* feat(models): add gpt-6-astra to the codex model catalog by @selfcontained in https://github.com/selfcontained/dispatch/pull/1076

### Dispatch Harness

- **Dispatch Harness**: a `dispatch` agent type that runs a coding agent as a child process over the Agent Client Protocol and renders the session as turns in the new **Harness** view: prompt line, a collapsible activity rail per turn (tool calls with output, diffs, locations, live timers, nested subagent steps), the result, a visible queue with Send now and Remove, Stop and Ctrl+C, a tasks strip, a slash menu of the engine's commands, and a `/usage` dialog. Opt-in via Settings, Agent types.
- **Four engines**, chosen by the model id prefix: `claude/` (Claude Code through `claude-agent-acp`), `codex/` (Codex through `codex-acp`), `gemini/` (Gemini CLI), `opencode/` (OpenCode). Each uses the host CLI's own login; Dispatch holds no provider key. Install and login steps are in the runbook.
- Where an engine publishes nothing over ACP the view says so: Gemini CLI has no tasks strip, reports no usage, and sets its model at launch; Codex reports tokens without cost; OpenCode publishes no plan.
- Restart resilience: a turn a service restart cut short is marked interrupted, the agent resumes on `session/resume` at boot, queued chat is redelivered, and the agent is told to continue.
- Motion: every transition in the Harness view moves on one set of tokens and collapses under reduced motion.
- Schema: `agent_stream_events` (additive) and `agent_chat_messages.delivery_text` (additive), both guarded.
- Settings: **Usage budgets** takes a monthly USD amount for the engines that report cost (Claude Code, OpenCode).

### Other changes

These two are not about the harness, and they change agents you already have.

- **Launch guidance for every CLI agent type.** One rule is now added to the launch prompt of every `claude`, `codex`, `cursor` and `opencode` agent: once a task is accepted, do not end a turn after only announcing a plan or a status, continue into the work in the same turn, or report `waiting_user` or `blocked` when you genuinely cannot proceed. Existing agents pick it up the next time their session starts.
- **A persona review runs as its parent's own kind.** Before, a parent whose type had no saved reviewer type fell back to Codex; now it falls back to the parent's own type, so a Cursor parent's review runs on Cursor. A harness parent's review also inherits its engine, rather than defaulting to Claude Code.
