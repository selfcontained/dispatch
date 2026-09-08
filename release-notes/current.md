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
