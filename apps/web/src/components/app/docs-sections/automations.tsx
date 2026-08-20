import { Code, H3, P, Section } from "./primitives";

export function AutomationsContent() {
  return (
    <>
      <P>
        The Automations system has two layers: <strong>templates</strong> are
        reusable agent launch configurations, and <strong>jobs</strong> add
        scheduling, timeouts, monitoring, and structured reporting on top of a
        template. Both live under the <strong>Automations</strong> page,
        accessible from the sidebar.
      </P>

      <Section>
        <H3>Templates</H3>
        <P>
          A template captures a prompt, agent type, directory, worktree
          settings, and an optional set of runtime arguments. Launching a
          template creates a normal agent session with no supervision — ideal
          for quick-launch workflows like code review, feature scaffolding, or
          ad-hoc tasks.
        </P>
      </Section>

      <Section>
        <H3>Creating a template</H3>
        <P>
          Open the <strong>Automations</strong> page and select the{" "}
          <strong>Templates</strong> tab. Click <strong>Create</strong> and fill
          in:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <strong>Name</strong> — display name, unique within its directory.
          </li>
          <li>
            <strong>Description</strong> — optional short summary shown in the
            launch dialog and template list.
          </li>
          <li>
            <strong>Working directory</strong> — the repo the template runs
            against.
          </li>
          <li>
            <strong>Prompt</strong> — instructions sent as the agent's first
            message. Supports <Code>{"{{D:Arg Name}}"}</Code> placeholders for
            optional runtime arguments, plus filter-style modifiers like{" "}
            <Code>{"{{D:Arg Name|required|multiline}}"}</Code> (see below).
          </li>
          <li>
            <strong>Agent type</strong> — <Code>claude</Code>,{" "}
            <Code>codex</Code>, <Code>cursor</Code>, <Code>opencode</Code>, or{" "}
            <Code>terminal</Code>. Terminal templates launch a plain shell
            session and skip the prompt, worktree, full access, media, and
            self-improve fields below.
          </li>
          <li>
            <strong>Model</strong> — shown for CLI types with a curated model
            catalog (<Code>claude</Code>, <Code>codex</Code>). Launches pin the
            agent to that model; leave <strong>Default</strong> to use the CLI's
            own setting.
          </li>
          <li>
            <strong>Use worktree</strong> — give each launch its own git
            worktree. Optionally set a base branch and custom branch name.
          </li>
          <li>
            <strong>Full access</strong> — launch the CLI in its most permissive
            mode.
          </li>
          <li>
            <strong>Show in command palette</strong> — when on, the template
            appears in the <Code>Mod+K</Code> palette for quick access.
          </li>
          <li>
            <strong>Allow media attachments on launch</strong> — when on (the
            default), the launch dialog shows a Context section where you can
            attach files (images, PDFs, text) or paste links. These are pinned
            to the agent and available from the start of the session.
          </li>
          <li>
            <strong>Self improve after each run</strong> — appends run-only
            guidance asking the launched agent to reflect before finishing and,
            only when it finds a clear, durable improvement, update the saved
            prompt itself via <Code>update_template</Code>. The guidance is
            never persisted into the prompt, so it can't compound across runs.
          </li>
        </ul>
      </Section>

      <Section>
        <H3>Runtime arguments</H3>
        <P>
          Templates support <Code>{"{{D:Arg Name}}"}</Code> placeholders in
          their prompt. Arguments are optional by default. Add{" "}
          <Code>|required</Code> to enforce input at launch, and{" "}
          <Code>|multiline</Code> for a textarea-style field. Argument values
          are also pinned to the spawned agent's sidebar for reference.
        </P>
        <P>
          If you leave an optional argument blank, Dispatch removes that
          placeholder and leaves the surrounding text as-is. Write prompts so
          they still read naturally when optional values are omitted.
        </P>
        <P>
          For example, a prompt like{" "}
          <Code>
            {
              "Review the PR at {{D:PR URL|required}} focusing on {{D:Review Focus|multiline}}"
            }
          </Code>{" "}
          creates one required single-line field ("PR URL") and one optional
          multiline field ("Review Focus").
        </P>
        <P>
          If the same argument appears more than once, modifiers are merged.
          That means the argument is treated as required or multiline if any
          occurrence uses that modifier.
        </P>
      </Section>

      <Section>
        <H3>Launching templates</H3>
        <P>
          There are three ways to launch a template, and all three open the same
          launch dialog — there is no launch-on-click path, even for a template
          with no arguments:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <strong>Template detail pane</strong> — select a template in the
            sidebar. It lists the arguments the prompt expects, and{" "}
            <strong>Launch</strong> opens the dialog to fill them in.
          </li>
          <li>
            <strong>Inline play button</strong> — each template in the list has
            a play icon that opens a launch dialog where you can override the
            agent type and model and fill in any arguments before launching.
          </li>
          <li>
            <strong>Command palette</strong> (<Code>Mod+K</Code>) — callable
            templates appear under a "Templates" group. Selecting one opens a
            launch dialog where you can override the agent type and model and
            fill in arguments.
          </li>
        </ul>
        <P>
          Every launch dialog includes an <strong>Agent type</strong> selector
          that defaults to the template's configured type, and — for types with
          a curated model catalog — a <strong>Model</strong> selector that
          defaults to the template's saved model. This lets you run the same
          template with a different CLI or model without editing the template
          itself.
        </P>
        <P>
          When a template has <strong>Allow media attachments</strong> enabled,
          the launch dialog includes a <strong>Context</strong> section for
          attaching files or links. You can drag-and-drop files, use the{" "}
          <em>Add</em> menu to pick files or enter URLs, paste from the
          clipboard, or use the <em>Read clipboard</em> button to detect images
          and links. Attached items are pinned to the launched agent so they are
          available from the first turn.
        </P>
        <P>
          After launch, the new agent appears in the sidebar immediately and the
          view navigates to it.
        </P>
      </Section>

      <Section>
        <H3>Jobs</H3>
        <P>
          A job references a backing template and adds automation on top: cron
          scheduling, run timeouts, singleton enforcement, structured reporting
          via MCP tools, auto-archive, and webhook triggers. Jobs are the right
          choice for recurring or monitored work — nightly triage, release
          babysitting, janitorial cleanup — where you want a machine-readable
          outcome.
        </P>
        <P>
          Creating a job also creates a hidden backing template that holds the
          agent config (prompt, agent type, model, worktree, full access). It
          stays out of the Templates list and the palette, and the job's own
          forms are how you edit it. Job runs notify through the ordinary
          per-agent channels, with one exception — a job agent's{" "}
          <Code>done</Code>, <Code>waiting_user</Code>, or <Code>blocked</Code>{" "}
          event raises a browser notification like any other agent's, but is
          excluded from Slack.
        </P>
      </Section>

      <Section>
        <H3>Creating a job</H3>
        <P>
          Switch to the <strong>Jobs</strong> tab and click{" "}
          <strong>Create</strong>. The basic fields are:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <strong>Name</strong> — identifier used for the spawned agent and in
            run history.
          </li>
          <li>
            <strong>Working directory</strong> — repo the job runs against.
          </li>
          <li>
            <strong>Cron schedule</strong> — a 5-field cron expression (e.g.{" "}
            <Code>{"*/30 * * * *"}</Code>). Leave blank for an on-demand job
            that only runs when you click <strong>Run now</strong>. When a
            schedule is set, an <strong>Enabled</strong> switch appears so you
            can save the schedule without firing it yet.
          </li>
          <li>
            <strong>Agent type</strong> — <Code>claude</Code>,{" "}
            <Code>codex</Code>, <Code>cursor</Code>, or <Code>opencode</Code>.
            Terminal-type agents can't run jobs.
          </li>
          <li>
            <strong>Model</strong> — shown for agent types with a curated model
            catalog (<Code>claude</Code>, <Code>codex</Code>). Runs pin the
            spawned agent to that model; leave <strong>Default</strong> to use
            the CLI's own setting.
          </li>
          <li>
            <strong>Prompt</strong> — the instructions sent as the agent's first
            message. Dispatch prepends a short preamble that identifies the job
            and run and reminds the agent to drive the run to a terminal state.
            Required before a run can start. Unlike templates, jobs never
            collect arguments at run time — <Code>{"{{D:Arg Name}}"}</Code>{" "}
            placeholders are only substituted from default values saved via the
            API.
          </li>
          <li>
            <strong>Self improve after each run</strong> — appends run-only
            guidance asking the job agent to reflect before finishing and, only
            when it finds a clear, durable improvement, update the job's saved
            prompt itself via <Code>update_job</Code>. For an existing job the
            toggle lives on its <strong>Prompt</strong> tab.
          </li>
          <li>
            <strong>Show in command palette</strong> — marks the job as
            callable, shown as a badge in the jobs list. Quick launch from the{" "}
            <Code>Mod+K</Code> palette is currently only available for
            templates.
          </li>
          <li>
            <strong>Single instance</strong> — when on (the default), only one
            run can be active at a time. Turn off to allow overlapping runs of
            the same job.
          </li>
        </ul>
        <P>
          Open <strong>Advanced settings</strong> for the rest:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <strong>Run timeout, minutes</strong> — wall-clock ceiling measured
            from the moment the run starts, after which the scheduler
            force-stops it as <Code>timed_out</Code>. Defaults to 30 minutes. It
            keeps counting while the run is parked on a question, so raise it
            for jobs that expect to wait on a human.
          </li>
          <li>
            <strong>Wait for input, minutes</strong> — how long a run can sit in{" "}
            <Code>needs_input</Code> before being marked <Code>timed_out</Code>.
            Defaults to 24 hours, but the run timeout above applies at the same
            time and usually expires first.
          </li>
          <li>
            <strong>Use worktree</strong> — create a fresh git worktree for each
            run. Pick a <strong>base branch</strong> the worktree branches from
            and optionally a custom branch name.
          </li>
          <li>
            <strong>Full access</strong> — launches the CLI in its most
            permissive mode so the agent can run commands without prompts.
          </li>
          <li>
            <strong>Keep agent after run completes</strong> — by default the
            agent is auto-archived once a run reaches a terminal state. Check
            this to leave the agent (and its worktree) around for inspection.
            The job's detail pane then offers an <strong>Open session</strong>{" "}
            button to pick up where the run left off.
          </li>
        </ul>
        <P>
          After creating a job, open its <strong>Configure</strong> tab to
          adjust these settings and options like{" "}
          <strong>Webhook trigger</strong> — enable it, hit{" "}
          <strong>Save</strong>, and Dispatch generates a secret URL that fires
          a run via HTTP POST. No auth header is needed; the secret in the URL
          is the credential. The prompt itself is edited on the job's{" "}
          <strong>Prompt</strong> tab.
        </P>
        <P>
          The <strong>Enabled</strong> switch at the top of{" "}
          <strong>Configure</strong> is the exception to the Save button: it
          writes immediately, and it stays greyed out until the job has a
          schedule saved. The same tab ends with <strong>Remove job</strong>,
          which deletes the job, its schedule, and its run history.
        </P>
      </Section>

      <Section>
        <H3 id="on-demand-runs">On-demand runs</H3>
        <P>
          Every job has a <strong>Run now</strong> button on its detail pane.
          This spawns a run immediately with{" "}
          <Code>triggerSource: "manual"</Code> — useful for both on-demand-only
          jobs and for kicking a scheduled job off-cycle. Jobs with{" "}
          <strong>Webhook trigger</strong> enabled can also be fired by POSTing
          to their webhook URL (<Code>triggerSource: "webhook"</Code>). When{" "}
          <strong>Single instance</strong> is on (the default), only one run can
          be active per job at a time; with it off, overlapping runs are
          allowed.
        </P>
      </Section>

      <Section>
        <H3>Run lifecycle</H3>
        <P>
          A job agent is expected to drive its run to a terminal state by
          calling one of the lifecycle tools before it stops:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <Code>job_log</Code> — append structured progress during the run
            (task name + message, optional severity).
          </li>
          <li>
            <Code>job_complete</Code> — mark the run successful with a report (
            <Code>status</Code>, <Code>summary</Code>, <Code>tasks</Code>).
          </li>
          <li>
            <Code>job_failed</Code> — mark the run failed with the same report
            shape.
          </li>
          <li>
            <Code>job_needs_input</Code> — pause the run and surface the
            question on its History entry. Answer the agent in its own terminal
            session; the run stays in <Code>needs_input</Code> until the agent
            calls a terminal tool or a timeout fires. There is no answer box in
            the Jobs UI.
          </li>
        </ul>
        <P>
          Run statuses are <Code>started</Code>, <Code>running</Code>,{" "}
          <Code>needs_input</Code>, <Code>completed</Code>, <Code>failed</Code>,{" "}
          <Code>timed_out</Code>, and <Code>crashed</Code>. A run that exceeds
          its run timeout without reaching a terminal tool is force-stopped as{" "}
          <Code>timed_out</Code>; one whose agent session ends first — stopped,
          errored, or its tmux session gone — is recorded as{" "}
          <Code>crashed</Code>.
        </P>
      </Section>

      <Section>
        <H3>Tools available to job agents</H3>
        <P>
          On top of the lifecycle tools, job agents see a tailored slice of
          Dispatch's built-in MCP toolkit. These are stable across runs, so a
          recurring job's prompt can lean on them.
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <strong>Status &amp; comms</strong> — <Code>dispatch_event</Code>,{" "}
            <Code>dispatch_pin</Code>, <Code>dispatch_pins</Code>,{" "}
            <Code>dispatch_list_pins</Code>, <Code>dispatch_delete_pin</Code>,{" "}
            <Code>dispatch_share</Code>, <Code>dispatch_list_media</Code>,{" "}
            <Code>dispatch_delete_media</Code>,{" "}
            <Code>dispatch_rename_session</Code>, and{" "}
            <Code>dispatch_notify</Code> all behave the same as for standard
            agents. Renaming the session is handy when the job's prompt is
            generic but each run has a more specific topic.
          </li>
          <li>
            <strong>Pull requests</strong> — <Code>create_pr</Code> opens a PR
            from the current branch and <Code>get_pr_status</Code> polls CI.
            Useful for jobs that ship a routine change (cleanup PRs, dep bumps,
            doc audits).
          </li>
          <li>
            <strong>Discovery &amp; messaging</strong> —{" "}
            <Code>list_agents</Code>, <Code>dispatch_send_message</Code>,{" "}
            <Code>dispatch_launch_agent</Code>,{" "}
            <Code>dispatch_archive_agent</Code>, <Code>list_personas</Code>,{" "}
            <Code>persona_templates</Code>, <Code>persona_upsert</Code>,{" "}
            <Code>persona_validate</Code>, <Code>get_activity_summary</Code> and{" "}
            <Code>get_feedback_summary</Code> let a job sweep over recent
            activity, coordinate with other agents, or post a summary.
          </li>
          <li>
            <strong>Tracked reviews</strong> —{" "}
            <Code>dispatch_launch_persona</Code>,{" "}
            <Code>dispatch_review_list_feedback</Code>,{" "}
            <Code>dispatch_review_get_feedback</Code>,{" "}
            <Code>dispatch_review_add_message</Code>,{" "}
            <Code>dispatch_review_resolve</Code>, and{" "}
            <Code>dispatch_review_reopen</Code>. The same family covers findings
            a persona filed and feedback a human left on the Changes tab — read
            them, reply in the item thread, and set each outcome. See below.
          </li>
          <li>
            <strong>Brain (shared memory)</strong> —{" "}
            <Code>brain_get_object</Code>, <Code>brain_store_object</Code>,{" "}
            <Code>brain_list_objects</Code>, <Code>brain_delete_object</Code>,{" "}
            <Code>brain_list_push</Code>, <Code>brain_list_remove</Code>,{" "}
            <Code>brain_list_get</Code>, <Code>brain_get_list_item</Code>,{" "}
            <Code>brain_list_set</Code>, <Code>brain_list_delete</Code>,{" "}
            <Code>brain_append_event</Code>, <Code>brain_query_events</Code>,{" "}
            <Code>brain_get_event</Code>, and <Code>brain_delete_events</Code>.
            Same tools as standard agents.
          </li>
          <li>
            <strong>Automation CRUD</strong> — <Code>list_jobs</Code>,{" "}
            <Code>get_job</Code>, <Code>create_job</Code>,{" "}
            <Code>update_job</Code>, <Code>delete_job</Code>,{" "}
            <Code>run_job</Code>, <Code>list_templates</Code>,{" "}
            <Code>get_template</Code>, <Code>create_template</Code>,{" "}
            <Code>update_template</Code>, and <Code>delete_template</Code>. Same
            tools as standard agents.
          </li>
        </ul>
      </Section>

      <Section>
        <H3>Auto-review with personas</H3>
        <P>
          Because job agents can launch personas and act on their findings, a
          recurring job can self-review its own work without a human in the
          loop: open a PR with <Code>create_pr</Code>, launch a persona with{" "}
          <Code>dispatch_launch_persona</Code>, read any findings with{" "}
          <Code>dispatch_review_list_feedback</Code>, converse in item threads,
          and set each outcome with <Code>dispatch_review_resolve</Code>. A
          clean approval is recorded with its summary and requires no follow-up.
        </P>
      </Section>

      <Section>
        <H3>State across runs</H3>
        <P>
          Recurring jobs often need to pass context from one run to the next
          without re-inventorying the repo every time. Two approaches work well:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <strong>Filesystem handoff</strong> — a small markdown file at{" "}
            <Code>.dispatch/job-state/{"<job>"}.md</Code> that the prompt tells
            the agent to read at the start and overwrite at the end. Treat it as
            a note to the next run, not an append-only log; prune what's no
            longer relevant. This pattern is simple and version-controlled.
          </li>
          <li>
            <strong>Brain shared memory</strong> — use the{" "}
            <Code>brain_store_object</Code>, <Code>brain_get_object</Code>, and
            Brain list tools to persist structured state across runs without
            committing files. Brain objects support optimistic concurrency,
            while Brain lists support surgical queue-style updates, making them
            a good fit for state that multiple jobs or agents need to coordinate
            on.
          </li>
        </ul>
      </Section>

      <Section>
        <H3>History and status</H3>
        <P>
          Each job in the sidebar list shows its last run's status alongside its
          schedule and enabled state, plus <em>keeps agent</em> and{" "}
          <em>callable</em> markers where they apply. The Jobs overview (shown
          when no job is selected) covers the last 7 days: total runs, success
          rate, average duration and failure count, a daily-runs chart, an{" "}
          <strong>Upcoming</strong> list of the next scheduled runs, and a{" "}
          <strong>Recent Activity</strong> list that jumps straight to a run.
        </P>
        <P>
          Open the <strong>History</strong> tab on a job to browse past runs
          with their status, start time, duration, trigger source (Manual,
          Scheduled, or Webhook), and expandable report. An expanded run shows
          the report summary, each task with its own status, and the last five{" "}
          <Code>job_log</Code> lines per task — so write logs assuming only the
          tail is visible.
        </P>
      </Section>

      <Section>
        <H3>Automations UI</H3>
        <P>
          The Automations page has a tabbed sidebar with{" "}
          <strong>Templates</strong>, <strong>Jobs</strong>, and{" "}
          <strong>Brains</strong> tabs. The first two use the same flat-list
          layout with a sliding indicator that animates between them. Select an
          item to see its detail view, or use the inline play button on a
          template for quick launch. The <strong>Brains</strong> tab shows a
          collection-first browser for the repo-scoped Brain — select a project
          to browse its collections, objects, lists, and events.
        </P>
        <P>
          Brain data can also be cleaned up from here. Every object, list, and
          event card has its own delete button, and each section header has a{" "}
          <strong>Delete all</strong> action that clears just that entry type in
          the current scope — the selected collection, or every collection in
          the project when the <strong>All</strong> pill is active. Clearing
          only the events is the usual fix when one noisy job floods the log but
          the objects and lists around it are still worth keeping. Broader
          resets live one level up: <strong>Clear collection</strong> removes
          everything in the selected collection, and{" "}
          <strong>Clear project</strong> removes every entry for the project.
          All of them confirm first, and the confirmation quotes the scope's
          real totals — not the rows on screen, which are capped at 100 per
          section and narrowed further by the filter box.
        </P>
      </Section>
    </>
  );
}
