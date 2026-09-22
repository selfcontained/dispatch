import { Code, CodeBlock, H3, P, Section } from "./primitives";

export function ToolsContent() {
  return (
    <>
      <P>
        Repos can register custom MCP tools that agents call during a session.
        Tools are defined in <Code>.dispatch/tools.json</Code> at the repo root.
      </P>

      <Section>
        <H3>Defining tools</H3>
        <P>
          Each tool has a name, a description, and a command to run. Dispatch
          automatically prefixes tool names with <Code>repo_</Code> when
          exposing them to agents (any dots in the configured name are sanitized
          to underscores, since MCP clients don't support dots in tool names).
          The command executes at the root of the agent's checkout — the
          worktree root for worktree agents, otherwise the repo root — and the
          manifest is read from that same tree.
        </P>
        <CodeBlock>{`
// .dispatch/tools.json
{
  "tools": [
    {
      "name": "lint",
      "description": "Run the linter across the repo",
      "command": ["npm", "run", "lint"]
    },
    {
      "name": "test",
      "description": "Run the test suite",
      "command": ["npm", "test"]
    },
    {
      "name": "db_reset",
      "description": "Reset the dev database to a clean state",
      "command": ["./scripts/reset-db.sh"]
    }
  ]
}`}</CodeBlock>
        <P>
          The tools above would be available to agents as <Code>repo_lint</Code>
          , <Code>repo_test</Code>, and <Code>repo_db_reset</Code>.
        </P>
        <P>
          Every entry needs a <Code>name</Code>, a <Code>description</Code>, and
          a non-empty <Code>command</Code> array. The command is executed
          directly rather than through a shell, so pipes, globs, and{" "}
          <Code>&amp;&amp;</Code> don't work — put anything shell-shaped in a
          script and point <Code>command</Code> at that. A malformed entry
          aborts the whole manifest, and that failure takes the MCP request with
          it — so a typo in one tool doesn't just hide the <Code>repo_</Code>{" "}
          tools, it leaves the session with no Dispatch tools at all until the
          file is fixed.
        </P>
      </Section>

      <Section>
        <H3>Tool parameters</H3>
        <P>
          Tools can declare optional parameters that agents pass at call time.
          Each parameter maps to a CLI flag appended to the command. Supported
          types are <Code>string</Code> (appends <Code>--flag value</Code>) and{" "}
          <Code>boolean</Code> (appends <Code>--flag</Code> when true).
        </P>
        <CodeBlock>{`
{
  "name": "dev_up",
  "description": "Start the dev environment",
  "command": ["./bin/dev", "up"],
  "params": [
    {
      "name": "cwd",
      "type": "string",
      "flag": "--cwd",
      "description": "Working directory override"
    },
    {
      "name": "live",
      "type": "boolean",
      "flag": "--live",
      "description": "Enable live mode"
    }
  ]
}`}</CodeBlock>
        <P>
          When an agent calls <Code>repo_dev_up</Code> with{" "}
          <Code>{'{ cwd: "/path", live: true }'}</Code>, Dispatch runs{" "}
          <Code>./bin/dev up --cwd /path --live</Code>. Parameters that are
          omitted, false, or an empty string are skipped. Every parameter is
          optional to the agent, and <Code>name</Code>, <Code>type</Code>, and{" "}
          <Code>flag</Code> are required in the definition — the{" "}
          <Code>description</Code> is what the agent reads to decide what to
          pass, so it's worth writing.
        </P>
      </Section>

      <Section>
        <H3>What agents get back</H3>
        <P>
          A repo tool call doesn't fail on a non-zero exit. The command's stdout
          comes back as the tool's text result, with the exit code, stdout, and
          stderr in the structured payload, so the agent can read a failure and
          react to it instead of just seeing an error. Write scripts that fail
          loudly on stderr.
        </P>
        <P>
          Dispatch puts no time limit on a repo tool command (lifecycle hooks
          below do get one), though the agent's own MCP client may give up on a
          very long call.
        </P>
      </Section>

      <Section>
        <H3>Picking up changes</H3>
        <P>
          <Code>.dispatch/tools.json</Code> is re-read from disk on every tool
          listing — no server restart needed. The limit is on the agent's side:
          a CLI fetches its tool list once when the session starts and holds it.
          So an edited command runs the new version on the next call, but a
          newly added tool usually isn't callable until the agent reconnects or
          a new session starts.
        </P>
      </Section>

      <Section>
        <H3>Limiting tool scope</H3>
        <P>
          By default a repo tool is exposed to every agent type. Add an optional{" "}
          <Code>scope</Code> array to restrict where a tool shows up. Valid
          scopes are <Code>"agent"</Code> (standard agents and persona agents)
          and <Code>"job"</Code> (scheduled job runs). Useful for job-only
          maintenance commands that shouldn't clutter a regular agent's toolset.
          Anything Dispatch doesn't recognize is dropped from the array, and a{" "}
          <Code>scope</Code> left with nothing recognizable is treated as no
          scope at all — so a typo quietly re-exposes the tool everywhere.
        </P>
        <CodeBlock>{`
{
  "name": "list_dev_containers",
  "description": "List running dispatch-dev Postgres containers.",
  "command": ["docker", "ps", "--filter", "name=dispatch-postgres-"],
  "scope": ["job"]
}`}</CodeBlock>
      </Section>

      <Section>
        <H3 id="stream">The stream</H3>
        <P>
          Everything an agent hands the user goes into its{" "}
          <strong>stream</strong> as a block. The Chat tab renders the stream;
          the sidebar&apos;s Inbox tab and notifications derive from it. There
          is one stream per root agent — children post into their parent&apos;s
          stream — and every top-level block has a thread that opens as a page
          in the drawer. Three tools cover it:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <Code>post</Code> — post a block. Without <Code>to</Code> it goes to
            the agent&apos;s own stream, where the user reads it; with{" "}
            <Code>to: &lt;agentId&gt;</Code> it is delivered to that agent as a
            prompt (any agent, any time). Takes <Code>text</Code> plus, by kind,{" "}
            <Code>question</Code>, <Code>form</Code>, <Code>review</Code>,{" "}
            <Code>tasks</Code>, <Code>link</Code>, and <Code>attachments</Code>;{" "}
            <Code>replyTo</Code> threads it under another block, and{" "}
            <Code>notify: true</Code> also sends the browser/Slack notification.
            Returns <Code>{"{ id, createdAt }"}</Code>.
          </li>
          <li>
            <Code>update</Code> — revise a block the agent posted (
            <Code>text</Code>, <Code>data</Code>, <Code>attachments</Code>,{" "}
            <Code>state</Code>), or change the <Code>state</Code> of a block
            addressed to it — resolve a finding on a review it received, or move
            a task.
          </li>
          <li>
            <Code>react</Code> — put an emoji reaction on a block someone else
            posted (the user&apos;s message, another agent&apos;s post); pass{" "}
            <Code>remove: true</Code> to take it off.
          </li>
        </ul>
        <P>Block kinds:</P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <Code>text</Code> — markdown. An agent&apos;s ordinary replies
            already appear in the stream as it writes them, so <Code>post</Code>{" "}
            is for what plain text cannot do.
          </li>
          <li>
            <Code>question</Code> —{" "}
            <Code>{"{ options: [{ label, value? }] }"}</Code>, rendered as a row
            of buttons; the user&apos;s answer comes back as the agent&apos;s
            next prompt and is recorded on the block.
          </li>
          <li>
            <Code>form</Code> —{" "}
            <Code>{"{ fields: [{ id, label, type, ... }] }"}</Code>; the user
            fills it in and the submission is delivered the same way.
          </li>
          <li>
            <Code>file</Code> — a file the agent shared, carried as an
            attachment: <Code>{'attachments: [{ type: "file", path }]'}</Code>{" "}
            uploads a file from the agent&apos;s checkout (or names an already
            shared one by <Code>fileName</Code> / <Code>fileId</Code>). Links,
            PRs, and code snippets are attachments too.
          </li>
          <li>
            <Code>link</Code> — <Code>{"{ url, title? }"}</Code>. A pull request
            is a link.
          </li>
          <li>
            <Code>review</Code> —{" "}
            <Code>
              {
                "{ verdict, summary, findings: [{ id, severity, title, body, path?, line? }] }"
              }
            </Code>
            ; each finding is <Code>open</Code> until it is resolved as{" "}
            <Code>fixed</Code> or <Code>dismissed</Code> (with a note) in the
            block&apos;s state, and can be reopened (see Reviewers).
          </li>
          <li>
            <Code>tasks</Code> — <Code>{"{ items: [{ id, text }] }"}</Code>, a
            checklist whose items the agent moves between <Code>todo</Code>,{" "}
            <Code>now</Code>, and <Code>done</Code> with <Code>update</Code>;
            the user reads it.
          </li>
        </ul>
        <P>
          Status is derived by Dispatch, never reported by the agent: an open
          turn is <strong>working</strong>, an open question or form addressed
          to the user is <strong>waiting</strong>, neither is{" "}
          <strong>idle</strong>, and a failed turn or exited session is{" "}
          <strong>blocked</strong>.
        </P>
      </Section>

      <Section>
        <H3>Built-in tools</H3>
        <P>
          Dispatch also provides built-in tools that are always available,
          regardless of repo configuration. Standard agents see the set below.
          Persona agents and scheduled jobs get tailored subsets — for example,
          jobs get <Code>job_complete</Code>, <Code>job_failed</Code>,{" "}
          <Code>job_needs_input</Code>, and <Code>job_log</Code>.
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <Code>post</Code>, <Code>update</Code>, <Code>react</Code> — the
            stream tools above
          </li>
          <li>
            <Code>rename_session</Code> — rename the current agent session
          </li>
          <li>
            <Code>login_link</Code> — mint a short-lived link that opens the
            Dispatch UI signed in, for driving it in a browser
          </li>
          <li>
            <Code>list_files</Code> — list files shared with or by the current
            agent, or by its parent or a direct child via{" "}
            <Code>ownerAgentId</Code>
          </li>
          <li>
            <Code>delete_file</Code> — permanently remove a shared file by its
            listed file name
          </li>
          <li>
            <Code>list_personas</Code> — list the personas defined for the
            current repo
          </li>
          <li>
            <Code>persona_templates</Code>, <Code>persona_upsert</Code>,{" "}
            <Code>persona_validate</Code> — starter templates plus create/update
            and validation for persona files in the agent's checkout (see the
            Reviewers section)
          </li>
          <li>
            <Code>launch_agent</Code> — launch a new agent as a child of the
            current session with a name, prompt, and optional agent type, model,
            working directory, worktree settings, full access mode, or template.
            Pass <Code>persona: &lt;slug&gt;</Code> to run it as that persona,
            with the prompt as its briefing. Pass <Code>child: false</Code> to
            launch it outside the caller's lineage as a top-level agent instead.
            With a <Code>templateId</Code>, the template's own prompt is
            rendered and its placeholders fill from <Code>templateArgs</Code>{" "}
            (the names come back from <Code>list_templates</Code> /{" "}
            <Code>get_template</Code> as <Code>promptArgs</Code>); anything left
            in the caller's prompt follows the rendered template
          </li>
          <li>
            <Code>archive_agent</Code> — archive an agent this session launched,
            once its output has been consumed, or the session itself by passing
            its own agent ID; optionally keeping or force-removing the worktree.
            A session archiving itself stops a moment after the call returns, so
            it belongs last in a turn
          </li>
          <li>
            <Code>list_agents</Code> — list other agents in the same repo with
            their IDs, names, statuses, and latest activity, plus lineage: each
            entry's parent, how it relates to the caller (child, descendant,
            parent, ancestor, sibling, unrelated), and who launched it when that
            is not the parent
          </li>
          <li>
            <Code>get_activity_summary</Code>, <Code>get_feedback_summary</Code>{" "}
            — analytics queries over recent Dispatch activity
          </li>
          <li>
            <Code>brain_get_object</Code>, <Code>brain_store_object</Code>,{" "}
            <Code>brain_list_objects</Code>, <Code>brain_delete_object</Code> —
            read and write shared objects in the repo-scoped Brain (see below)
          </li>
          <li>
            <Code>brain_list_push</Code>, <Code>brain_list_remove</Code>,{" "}
            <Code>brain_list_get</Code>, <Code>brain_get_list_item</Code>,{" "}
            <Code>brain_list_set</Code>, <Code>brain_list_delete</Code> — manage
            ordered Brain lists without rewriting whole arrays
          </li>
          <li>
            <Code>brain_append_event</Code>, <Code>brain_query_events</Code>,{" "}
            <Code>brain_get_event</Code>, <Code>brain_delete_events</Code> —
            append to, query, and prune the Brain's event log
          </li>
          <li>
            <Code>list_jobs</Code>, <Code>get_job</Code>,{" "}
            <Code>create_job</Code>, <Code>update_job</Code>,{" "}
            <Code>delete_job</Code>, <Code>run_job</Code> — manage and trigger
            Dispatch jobs programmatically
          </li>
          <li>
            <Code>list_templates</Code>, <Code>get_template</Code>,{" "}
            <Code>create_template</Code>, <Code>update_template</Code>,{" "}
            <Code>delete_template</Code> — manage reusable agent launch
            templates
          </li>
          <li>
            <Code>list_personalities</Code>, <Code>create_personality</Code>,{" "}
            <Code>update_personality</Code>, <Code>delete_personality</Code>,{" "}
            <Code>set_active_personality</Code>,{" "}
            <Code>clear_active_personality</Code> — manage saved personalities
            and which one is active (see the Personalities section)
          </li>
        </ul>
        <P>
          Everything a tool returns stays in the calling agent's context, so
          list-shaped tools return a lean projection — long strings are
          truncated with a marker showing how much was dropped — and there is
          always a matching single-item tool to read one entry in full (
          <Code>get_template</Code>, <Code>brain_get_object</Code>,{" "}
          <Code>brain_get_event</Code>, <Code>brain_get_list_item</Code>).
          Writes confirm what changed rather than echoing back the record.
        </P>
        <P>
          <Code>list_agents</Code> and <Code>post</Code> see agents in the same
          git repository.
        </P>
      </Section>

      <Section>
        <H3 id="brain">Brain (shared memory)</H3>
        <P>
          The Brain is a repo-scoped key-value store and event log that lets
          agents share structured state. Objects are organized into collections,
          identified by name, and tracked with an integer revision for
          optimistic concurrency — updates require passing the expected revision
          so concurrent writes don't silently overwrite each other. Lists are
          ordered mutable collections with push, remove, get, set, and delete
          operations, which makes them a better fit for queues, backlogs, and
          rolling history than stuffing arrays into objects. Positional list
          updates require the current revision because removals reindex later
          items. List pushes are capped per call, and bounded list sizes keep
          remove/reindex work predictable. Events are append-only — never
          edited, only added to — and can be filtered by collection, kind,
          subject, tags, and time range. They can still be pruned:{" "}
          <Code>brain_delete_events</Code> deletes either explicit event ids or
          every event matching a filter within one collection, and{" "}
          <Code>dryRun</Code> reports how many the same selector would remove
          before anything is deleted.
        </P>
        <P>
          Brain tools are available to both standard agents and job agents.
          Persona agents do not have access. Common use cases include passing
          findings or assessments between recurring job runs, sharing
          configuration between agents working in the same repo, and recording
          structured observations that other agents can query. You can inspect
          Brain activity — and delete individual entries or clear a whole
          collection, entry type, or project — from the <strong>Brains</strong>{" "}
          tab on the Automations page.
        </P>
      </Section>

      <Section>
        <H3 id="dispatch-launch-agent">Agent orchestration</H3>
        <P>
          Agents can spawn other agents using <Code>launch_agent</Code>. The
          launched agent runs independently, and by default it is a child of the
          launcher — nested in that card's <strong>Sub Agents</strong> list, the
          same place persona agents render. Pass <Code>child: false</Code> for a
          top-level agent outside the launcher's lineage; that is the only
          launch a sub agent itself can make. Archiving the parent cascades to
          its children — persona agents and plain child agents alike. An agent
          launched with <Code>child: false</Code> is independent and is left
          running.
        </P>
        <P>
          Use <Code>list_agents</Code> to discover running agents and{" "}
          <Code>post</Code> with <Code>to</Code> to coordinate between them. A
          post to another agent is a block in the root agent&apos;s stream,
          shown on both agents&apos; pages. The launched agent receives the
          launcher&apos;s ID in its startup context so it can post back.
        </P>
      </Section>

      <Section>
        <H3>Lifecycle hooks</H3>
        <P>
          Repos can define lifecycle hooks in <Code>.dispatch/tools.json</Code>{" "}
          that run automatically at key moments. Currently the <Code>stop</Code>{" "}
          hook is supported — it runs when an agent is paused or archived,
          useful for teardown tasks like shutting down dev servers. Hooks run at
          the root of the agent's checkout with a 15-second timeout, and they
          are best-effort: a failing hook is logged but never blocks shutdown.
        </P>
        <CodeBlock>{`
{
  "hooks": {
    "stop": {
      "command": ["./bin/cleanup.sh"],
      "description": "Tear down the agent's dev environment on stop."
    }
  }
}`}</CodeBlock>
      </Section>

      <Section>
        <H3>Environment</H3>
        <P>
          Agent sessions run as non-login, non-interactive processes, so
          standard shell profiles are <strong>not</strong> sourced. If agents
          need tools like <Code>nvm</Code>, <Code>pyenv</Code>, or tokens like{" "}
          <Code>GH_TOKEN</Code>, add them to <Code>~/.dispatch/env</Code>:
        </P>
        <CodeBlock>{`# ~/.dispatch/env
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export GH_TOKEN="ghp_..."`}</CodeBlock>
        <P>
          Avoid using <Code>exit</Code> in this file — it runs in the setup
          script's shell and will kill the agent session.
        </P>
        <P>
          Repo tool commands and hooks also receive{" "}
          <Code>DISPATCH_AGENT_ID</Code> in their environment, so scripts can
          scope resources (databases, temp directories, ports) per agent.
        </P>
      </Section>
    </>
  );
}
