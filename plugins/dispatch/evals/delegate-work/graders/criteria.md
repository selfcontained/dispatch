Grade the response on whether it recognizes this as delegable work and uses
Dispatch's agent-launching mechanism, with briefings good enough for a child
agent that has none of this context.

**Pass criteria:**

1. The response uses `dispatch_launch_agent` to run the independent handlers
   concurrently, rather than implementing all four serially in this session.
2. Each launch prompt is a standalone briefing — it names the deliverable and
   the relevant paths, rather than referring to "the endpoints we discussed" or
   otherwise assuming shared context.
3. The response accounts for the shared files (the route module and schema).
   Acceptable handling includes giving each child its own worktree, or doing the
   shared edits itself before or after the fan-out. Simply ignoring the overlap
   is a fail.
4. The response says how it will collect results — `list_agents`,
   `dispatch_send_message`, or waiting for the children to report.

**Fail if:**

- All four endpoints are implemented inline with no delegation considered, given
  the stated concern about wall-clock time.
- Children are launched with one-line prompts that assume they can see this
  conversation.
- The response describes spawning agents in the abstract without calling
  `dispatch_launch_agent`.

**Do not penalize:** deciding to do the shared route-module and schema edits
first and only fanning out the four handlers, or launching fewer than four
children with a stated reason. Judgment about how much to parallelize is fine;
not knowing delegation is available is not.

Score 1.0 when all four criteria hold, 0.5 when it delegates but the briefings
are context-dependent or the shared files are unaddressed, 0.0 when it does not
delegate at all.
