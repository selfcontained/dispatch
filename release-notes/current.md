## What's Changed
* refactor(server): sweep three inline errorMessage ternaries onto the shared helper (#tech-debt) by @selfcontained in https://github.com/selfcontained/dispatch/pull/1079
* test(web): cover slot-actions and progress-block logic by @selfcontained in https://github.com/selfcontained/dispatch/pull/1080
* refactor(web): split the chat attachment views out of chat-entries.tsx (#tech-debt) by @selfcontained in https://github.com/selfcontained/dispatch/pull/1081
* feat(chat): emoji reactions on Chat messages, both directions by @selfcontained in https://github.com/selfcontained/dispatch/pull/1082

### Dispatch agent

- **Dispatch agent**: a `dispatch` agent type that runs a coding agent as a child process over the Agent Client Protocol and renders the session as turns in the Chat feed: prompt, a collapsible activity rail per turn (tool calls with output, diffs, locations, live timers, nested subagent steps), the result, a visible queue with Send now and Remove, Stop and Ctrl+C, a tasks strip, a slash menu of the engine's commands, and a `/usage` dialog. Opt-in via Settings, **Dispatch agent (beta)**.
- **One feed for every agent type.** A dispatch agent's turns are entries in the same Chat feed every other agent type reads, so reviews, pins, the presence strip, the unread badge, day dividers, copy and the child-agent filter all work for it. There is no second view and no second endpoint, and a streamed chunk updates one row instead of refetching the page.
- **Provider choices**: Claude Code, Codex, and OpenCode. Gemini CLI support remains in the backend but is hidden from new UI choices pending sign-in and account-access follow-up. Install and login steps are in the runbook.
- Task lists are available to every Dispatch agent through `dispatch_update_tasks`, including Claude Code sessions without a native todo tool. The list shows current work and progress above the composer. Native ACP plan updates continue to work. A task is only shown as active while a turn is running: when a turn ends, is stopped, or is cut by a restart, a task left `in_progress` goes back to `pending` and the strip reads `paused`.
- **Edit a running message**: Edit opens the running turn's message in the composer and changes nothing else. The agent keeps working until the edit is sent. Sending stops the turn, removes it and its message from the feed, and runs the new text ahead of anything queued. Cancel, or Escape, backs out and restores what was in the field.
- A step still open when its turn ends, is stopped, or loses its engine is settled with the reason, so an interrupted turn never shows a step running. A late report from the engine still overwrites the settlement.
- **Background processes**: agents can start non-interactive commands without blocking a turn and receive a completion message automatically. The compact list shares task-list styling, with one right-aligned disclosure arrow, running work first, and expandable history. Open a row for output, exit status, and stop controls. Process history survives reloads; restarting the server interrupts, rather than reruns, unfinished commands.
- Usage shows when the provider last reported it. Claude refreshes subscription usage through the signed-in CLI's login, read from `.claude/.credentials.json` or, on macOS, from the login Keychain, with a dated fallback that says why if refreshing fails. The dialog's Refresh button asks the provider again instead of answering from the one-minute cache. Codex selects the newest report by its timestamp, even if an older log was recently modified.
- New Dispatch sessions show an animated startup card in Chat, with estimated progress tied to workspace setup, dependency installation, provider connection, and session settings. Reduced-motion preferences are respected. Review cards remain fully visible in compact peer messages.
- Where an engine publishes nothing over ACP the feed says so: Gemini CLI reports no usage and sets its model at launch; Codex reports tokens without cost.
- Restart resilience: a turn a service restart cut short is marked interrupted, the agent resumes on `session/resume` at boot, queued chat is redelivered, and the agent is told to continue.
- Motion: every transition inside a turn moves on one set of tokens and collapses under reduced motion.
- Schema: `agent_stream_events` (additive) and `agent_chat_messages.delivery_text` (additive), both guarded.
- Settings: **Usage budgets** takes a monthly USD amount for the engines that report cost (Claude Code, OpenCode).

### Other changes

These changes also apply to existing CLI agents.

- Long chat histories and long top-level activity rails now render a viewport-sized window instead of mounting every loaded row. Reading positions and activity disclosures are retained while scrolling through history.
- **Launch guidance for every CLI agent type.** One rule is now added to the launch prompt of every `claude`, `codex`, `cursor` and `opencode` agent: once a task is accepted, do not end a turn after only announcing a plan or a status, continue into the work in the same turn, or report `waiting_user` or `blocked` when you genuinely cannot proceed. Existing agents pick it up the next time their session starts.
- **A persona review runs as its parent's own kind.** Before, a parent whose type had no saved reviewer type fell back to Codex; now it falls back to the parent's own type, so a Cursor parent's review runs on Cursor. A Dispatch parent's review also inherits its engine, rather than defaulting to Claude Code.

**Full Changelog**: https://github.com/selfcontained/dispatch/compare/v0.38.13-harness.3...v0.38.14
