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
          omitted or false are skipped.
        </P>
      </Section>

      <Section>
        <H3>Limiting tool scope</H3>
        <P>
          By default a repo tool is exposed to every agent type. Add an optional{" "}
          <Code>scope</Code> array to restrict where a tool shows up. Valid
          scopes are <Code>"agent"</Code> (standard agents and persona
          reviewers) and <Code>"job"</Code> (scheduled job runs). Useful for
          job-only maintenance commands that shouldn't clutter a regular agent's
          toolset.
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
        <H3>Built-in tools</H3>
        <P>
          Dispatch also provides built-in tools that are always available,
          regardless of repo configuration. Standard agents see the set below.
          Persona reviewers and scheduled jobs get tailored subsets — for
          example, review agents get <Code>dispatch_review_submit</Code> and{" "}
          <Code>get_parent_context</Code>, and jobs get{" "}
          <Code>job_complete</Code>, <Code>job_failed</Code>,{" "}
          <Code>job_needs_input</Code>, and <Code>job_log</Code>.
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <Code>create_pr</Code> — open a pull request from the current branch
          </li>
          <li>
            <Code>get_pr_status</Code> — check CI status on a pull request
          </li>
          <li>
            <Code>dispatch_event</Code> — report agent status (working, blocked,
            waiting_user, done, idle)
          </li>
          <li>
            <Code>dispatch_rename_session</Code> — rename the current agent
            session
          </li>
          <li>
            <Code>dispatch_notify</Code> — send a Slack notification (rate
            limited, supports mrkdwn)
          </li>
          <li>
            <Code>dispatch_pin</Code> — pin a label/value pair to the sidebar
            (URLs, ports, filenames, PRs, markdown summaries)
          </li>
          <li>
            <Code>dispatch_share</Code> — publish a screenshot, image, video, or
            text snippet to the session's media stream
          </li>
          <li>
            <Code>dispatch_list_media</Code> — list media shared with or by the
            current agent
          </li>
          <li>
            <Code>dispatch_delete_media</Code> — permanently remove a shared
            media file by its listed file name
          </li>
          <li>
            <Code>dispatch_list_pins</Code> — list the current sidebar pins so
            stale pins can be removed by ID
          </li>
          <li>
            <Code>dispatch_delete_pin</Code> — permanently remove a pin using
            its stable ID from <Code>dispatch_list_pins</Code>
          </li>
          <li>
            <Code>list_personas</Code> — list persona reviewers defined for the
            current repo
          </li>
          <li>
            <Code>persona_templates</Code>, <Code>persona_upsert</Code>,{" "}
            <Code>persona_validate</Code> — starter templates plus create/update
            and validation for persona files in the agent's checkout (see the
            Reviewers section)
          </li>
          <li>
            <Code>dispatch_launch_persona</Code> — launch a persona agent as a
            child of the current session
          </li>
          <li>
            <Code>dispatch_review_submit</Code> and{" "}
            <Code>dispatch_review_add_feedback</Code> — reviewer-agent tools to
            create a summarized review and add a genuinely new concern
          </li>
          <li>
            <Code>dispatch_review_list_feedback</Code> — list review feedback
            items and their tracked thread messages
          </li>
          <li>
            <Code>dispatch_review_resolve</Code> — resolve a review feedback
            item as fixed or dismissed; persona reviewers use it after verifying
            the parent's fix
          </li>
          <li>
            <Code>dispatch_review_add_message</Code> — reply to a review
            feedback thread (ask a clarifying question or explain an approach)
          </li>
          <li>
            <Code>dispatch_review_reopen</Code> — reopen a resolved item that
            needs more work
          </li>
          <li>
            <Code>dispatch_launch_agent</Code> — launch a new agent as a child
            of the current session with a name, prompt, and optional agent type,
            working directory, worktree settings, full access mode, or template
          </li>
          <li>
            <Code>list_agents</Code> — list other agents in the same repo with
            their IDs, names, statuses, and latest activity
          </li>
          <li>
            <Code>dispatch_send_message</Code> — send a message to another
            running agent by ID or name; the target can reply the same way
          </li>
          <li>
            <Code>get_activity_summary</Code>, <Code>get_agent_history</Code>,{" "}
            <Code>get_feedback_summary</Code> — analytics queries over recent
            Dispatch activity
          </li>
          <li>
            <Code>whiteboard_get</Code>, <Code>whiteboard_update</Code>,{" "}
            <Code>whiteboard_clear</Code> — read, draw on, and clear the agent's
            shared whiteboard (see the Agents section)
          </li>
          <li>
            <Code>brain_get_object</Code>, <Code>brain_store_object</Code>,{" "}
            <Code>brain_list_objects</Code>, <Code>brain_delete_object</Code> —
            read and write shared objects in the repo-scoped Brain (see below)
          </li>
          <li>
            <Code>brain_list_push</Code>, <Code>brain_list_remove</Code>,{" "}
            <Code>brain_list_get</Code>, <Code>brain_list_set</Code>,{" "}
            <Code>brain_list_delete</Code> — manage ordered Brain lists without
            rewriting whole arrays
          </li>
          <li>
            <Code>brain_append_event</Code>, <Code>brain_query_events</Code> —
            append to and query the Brain's immutable event log
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
          By default, <Code>list_agents</Code> and{" "}
          <Code>dispatch_send_message</Code> only see agents in the same git
          repository. To let agents coordinate across repos, enable{" "}
          <strong>Allow messaging agents in other repositories</strong> in{" "}
          <strong>Settings → Agents</strong>.
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
          remove/reindex work predictable. Events are append-only and can be
          filtered by collection, kind, subject, tags, and time range.
        </P>
        <P>
          Brain tools are available to both standard agents and job agents.
          Persona reviewers do not have access. Common use cases include passing
          findings or assessments between recurring job runs, sharing
          configuration between agents working in the same repo, and recording
          structured observations that other agents can query. You can inspect
          Brain activity from the <strong>Brains</strong> tab on the Automations
          page.
        </P>
      </Section>

      <Section>
        <H3 id="dispatch-launch-agent">Agent orchestration</H3>
        <P>
          Agents can spawn other agents using <Code>dispatch_launch_agent</Code>
          . The launched agent runs independently and appears as a top-level
          entry in the sidebar — it is not nested under its parent like persona
          reviewers. Archiving the parent does not cascade to launched agents.
        </P>
        <P>
          Use <Code>list_agents</Code> to discover running agents and{" "}
          <Code>dispatch_send_message</Code> to coordinate between them.
          Messages are persisted and visible in the <strong>Messages</strong>{" "}
          tab of the media sidebar. The launched agent receives the parent's ID
          in its startup context so it can message back.
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
          Agent sessions run inside tmux (non-login, non-interactive), so
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
