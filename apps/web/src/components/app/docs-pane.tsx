import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Bell,
  Briefcase,
  GitBranch,
  Image,
  Monitor,
  PlugZap,
  Signal,
  Users,
  X,
} from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";

export type DocsSection =
  | "agents"
  | "tools"
  | "jobs"
  | "worktrees"
  | "personas"
  | "events"
  | "media"
  | "notifications";

type DocsPaneProps = {
  open: boolean;
  onClose: () => void;
  initialSection?: string;
  onSectionChange?: (section: string | null) => void;
};

type SectionDef = {
  id: DocsSection;
  label: string;
  icon: typeof Monitor;
  title: string;
  content: JSX.Element;
};

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 text-[0.85em] font-mono text-foreground">
      {children}
    </code>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-muted/60 px-4 py-3 text-sm leading-relaxed font-mono text-foreground">
      {children.trim()}
    </pre>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-base font-semibold text-foreground">{children}</h3>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3">{children}</div>;
}

const SECTIONS: SectionDef[] = [
  {
    id: "agents",
    label: "Agents",
    icon: Monitor,
    title: "Agents",
    content: (
      <>
        <Section>
          <H3>Creating an agent</H3>
          <P>
            Click <strong>Create</strong> in the sidebar (or use the dropdown
            arrow to pick a specific agent type). Fill in the create form:
          </P>
          <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
            <li>
              <strong>Type</strong> — pick a CLI assistant (<Code>claude</Code>,{" "}
              <Code>codex</Code>, <Code>opencode</Code>) or{" "}
              <Code>terminal</Code> for a plain tmux shell with no CLI attached.
              Disabled types can be enabled in Settings.
            </li>
            <li>
              <strong>Name</strong> — optional display name. Leave it blank and
              the agent picks its own name once it has a sense of the task.
              Terminal agents fall back to a generated name.
            </li>
            <li>
              <strong>Working directory</strong> — path to the repo.
              Autocompletes as you type and validates that the directory exists.
              Recent directories are saved for quick selection.
            </li>
            <li>
              <strong>Create managed git worktree</strong> — checked by default
              (and disabled when the working directory isn't a git repo).
              Creates an isolated worktree so the agent works without touching
              your primary checkout. A nested{" "}
              <strong>Create a new branch in this worktree</strong> sub-checkbox
              controls whether Dispatch forks a new working branch from the
              starting branch (on, default — the authoring flow) or just checks
              out the starting branch directly (off — review/investigation
              flows). See the Worktrees section for details.
            </li>
            <li>
              <strong>Full access mode</strong> (CLI types only) — starts the
              CLI in its most permissive execution mode, so the agent can run
              commands and edit files without confirmation prompts.
            </li>
            <li>
              <strong>Autonomous Review</strong> (CLI types only) — when
              enabled, the agent automatically launches one reviewer agent on
              completion and addresses its feedback before finishing.
            </li>
          </ul>
          <P>
            Click <strong>Create</strong> to start the agent immediately. For
            CLI types, <strong>Create with context</strong> opens a second step
            where you can add startup instructions, attach files, and pin links
            for the new session before launch; terminal agents skip this since
            there is no CLI to send a message to.
          </P>
        </Section>

        <Section>
          <H3>Setup phases</H3>
          <P>
            After creating an agent, the sidebar shows a progress indicator as
            it moves through setup: creating the worktree, copying environment
            files, installing dependencies, and starting the session. Once setup
            completes the agent transitions to <strong>running</strong>.
          </P>
        </Section>

        <Section>
          <H3>Status indicators</H3>
          <P>
            CLI agents in the sidebar show a color-coded status from their
            latest event: green for <strong>working</strong>, red for{" "}
            <strong>blocked</strong>, yellow for <strong>waiting</strong>, and
            blue for <strong>done</strong>. The sidebar also shows the event
            message and how long ago it was reported. Terminal agents have no
            CLI to emit events, so their card stays neutral.
          </P>
        </Section>

        <Section>
          <H3>Starting and stopping</H3>
          <P>
            Press the play button to resume a stopped agent. Press the stop
            button to terminate it. Click an agent's name to attach your
            terminal to its session, or click again to detach without stopping.
          </P>
        </Section>

        <Section>
          <H3>Sessions are persistent</H3>
          <P>
            The agent runs inside <Code>tmux</Code>, independent of your
            browser. Closing the tab just detaches your terminal view — the
            agent keeps working. Open Dispatch again and click the agent to pick
            up where you left off.
          </P>
        </Section>

        <Section>
          <H3>Agent details</H3>
          <P>
            Expand an agent card to see its metadata: working directory or
            worktree path, git branch, and agent type. CLI agents also show
            whether they're running in full access or sandboxed mode, plus a
            feedback panel and persona launcher; terminal agents skip those
            since they have no CLI. Persona agents show their role and link to
            their parent agent.
          </P>
        </Section>

        <Section>
          <H3>Archiving agents</H3>
          <P>
            Click the archive button to remove an agent. If the agent has a
            worktree with unmerged commits or uncommitted changes, you'll be
            asked whether to keep or remove the worktree. Archived agents are
            preserved in the History section of the Activity page.
          </P>
        </Section>
      </>
    ),
  },
  {
    id: "tools",
    label: "Repo Tools",
    icon: PlugZap,
    title: "Repo Tools",
    content: (
      <>
        <P>
          Repos can register custom MCP tools that agents call during a session.
          Tools are defined in <Code>.dispatch/tools.json</Code> at the repo
          root.
        </P>

        <Section>
          <H3>Defining tools</H3>
          <P>
            Each tool has a name, a description, and a command to run. Dispatch
            automatically prefixes tool names with <Code>repo_</Code> when
            exposing them to agents (any dots in the configured name are
            sanitized to underscores, since MCP clients don't support dots in
            tool names). The command executes in the repo root when called.
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
            The tools above would be available to agents as{" "}
            <Code>repo_lint</Code>, <Code>repo_test</Code>, and{" "}
            <Code>repo_db_reset</Code>.
          </P>
        </Section>

        <Section>
          <H3>Tool parameters</H3>
          <P>
            Tools can declare optional parameters that agents pass at call time.
            Each parameter maps to a CLI flag appended to the command. Supported
            types are <Code>string</Code> (appends <Code>--flag value</Code>)
            and <Code>boolean</Code> (appends <Code>--flag</Code> when true).
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
            By default a repo tool is exposed to every agent type. Add an
            optional <Code>scope</Code> array to restrict where a tool shows up.
            Valid scopes are <Code>"agent"</Code> (standard agents),{" "}
            <Code>"reviewer"</Code> (persona reviewers), and <Code>"job"</Code>{" "}
            (scheduled job runs). Useful for job-only maintenance commands that
            shouldn't clutter a regular agent's toolset.
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
            example, persona agents get <Code>review_status</Code> and{" "}
            <Code>get_parent_context</Code>, and jobs get{" "}
            <Code>job_complete</Code>, <Code>job_failed</Code>,{" "}
            <Code>job_needs_input</Code>, and <Code>job_log</Code>.
          </P>
          <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
            <li>
              <Code>create_pr</Code> — open a pull request from the current
              branch
            </li>
            <li>
              <Code>get_pr_status</Code> — check CI status on a pull request
            </li>
            <li>
              <Code>dispatch_event</Code> — report agent status (working,
              blocked, waiting_user, done, idle)
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
              <Code>dispatch_share</Code> — publish a screenshot, image, video,
              or text snippet to the session's media stream
            </li>
            <li>
              <Code>dispatch_list_media</Code> — list media shared with or by
              the current agent
            </li>
            <li>
              <Code>dispatch_feedback</Code> — submit a structured finding with
              severity, file reference, and suggestion
            </li>
            <li>
              <Code>list_personas</Code> — list persona reviewers defined for
              the current repo
            </li>
            <li>
              <Code>dispatch_launch_persona</Code> — launch a persona agent as a
              child of the current session
            </li>
            <li>
              <Code>dispatch_get_feedback</Code> — retrieve feedback submitted
              by child persona agents
            </li>
            <li>
              <Code>dispatch_resolve_feedback</Code> — mark a feedback item as
              fixed or ignored
            </li>
            <li>
              <Code>get_activity_summary</Code>, <Code>get_agent_history</Code>,{" "}
              <Code>get_feedback_summary</Code> — analytics queries over recent
              Dispatch activity
            </li>
          </ul>
        </Section>

        <Section>
          <H3>Lifecycle hooks</H3>
          <P>
            Repos can define lifecycle hooks in{" "}
            <Code>.dispatch/tools.json</Code> that run automatically at key
            moments. Currently the <Code>stop</Code> hook is supported — it runs
            when an agent is stopped or terminated, useful for teardown tasks
            like shutting down dev servers.
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
    ),
  },
  {
    id: "jobs",
    label: "Jobs",
    icon: Briefcase,
    title: "Jobs",
    content: (
      <>
        <P>
          Jobs are saved agent prompts that you can run on a cron schedule or on
          demand. Each run spawns a fresh agent that works in its own worktree
          and reports progress through a small set of lifecycle tools.
        </P>

        <Section>
          <H3>Creating a job</H3>
          <P>
            Open the <strong>Jobs</strong> page from the sidebar and click{" "}
            <strong>Add job</strong>. Fill in the form:
          </P>
          <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
            <li>
              <strong>Name</strong> — identifier used for the spawned agent and
              in run history.
            </li>
            <li>
              <strong>Working directory</strong> — repo the job runs against.
            </li>
            <li>
              <strong>Prompt</strong> — the instructions sent as the agent's
              first message. Required before a run can start.
            </li>
            <li>
              <strong>Schedule</strong> — a 5-field cron expression (e.g.{" "}
              <Code>{"*/30 * * * *"}</Code>). Leave blank for an on-demand job
              that only runs when you click <strong>Run now</strong>.
            </li>
            <li>
              <strong>Agent type</strong> — <Code>claude</Code>,{" "}
              <Code>codex</Code>, or <Code>opencode</Code>.
            </li>
            <li>
              <strong>Full access</strong> — launches the CLI in its most
              permissive mode so the agent can run commands without prompts.
            </li>
            <li>
              <strong>Use worktree</strong> — create a fresh git worktree for
              each run. Pick a <strong>base branch</strong> the worktree
              branches from and optionally a custom branch name.
            </li>
            <li>
              <strong>Keep agent after run completes</strong> — by default the
              agent is auto-archived once a run reaches a terminal state. Check
              this to leave the agent (and its worktree) around for inspection.
            </li>
            <li>
              <strong>Enable on schedule</strong> — when checked, the cron
              schedule starts firing immediately after save. On-demand jobs can
              stay disabled and still be triggered with <strong>Run now</strong>
              .
            </li>
          </ul>
        </Section>

        <Section>
          <H3>On-demand runs</H3>
          <P>
            Every job has a <strong>Run now</strong> button on its detail pane.
            This spawns a run immediately with{" "}
            <Code>triggerSource: "manual"</Code> — useful for both
            on-demand-only jobs and for kicking a scheduled job off-cycle. Only
            one run can be active per job at a time.
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
              <Code>job_complete</Code> — mark the run successful with a report
              (<Code>status</Code>, <Code>summary</Code>, <Code>tasks</Code>).
            </li>
            <li>
              <Code>job_failed</Code> — mark the run failed with the same report
              shape.
            </li>
            <li>
              <Code>job_needs_input</Code> — pause the run and surface a
              question in the UI; the job stays in <Code>needs_input</Code>{" "}
              until someone resumes it (subject to a separate needs-input
              timeout).
            </li>
          </ul>
          <P>
            Run statuses are <Code>started</Code>, <Code>running</Code>,{" "}
            <Code>needs_input</Code>, <Code>completed</Code>,{" "}
            <Code>failed</Code>, <Code>timed_out</Code>, and{" "}
            <Code>crashed</Code>. A run that exceeds its timeout without
            reaching a terminal tool is marked <Code>timed_out</Code>.
          </P>
        </Section>

        <Section>
          <H3>History and status</H3>
          <P>
            Each job card shows the last run's status, when it finished, and the
            next scheduled fire time. Open the <strong>History</strong> tab on a
            job to browse past runs with their reports, durations, and trigger
            source (manual vs. scheduled).
          </P>
        </Section>
      </>
    ),
  },
  {
    id: "worktrees",
    label: "Worktrees",
    icon: GitBranch,
    title: "Worktrees",
    content: (
      <>
        <P>
          Git worktrees let agents work in isolation without touching the main
          checkout. Each agent gets its own directory — ideal for parallel
          tasks, review flows, or keeping exploratory work separate.
        </P>

        <Section>
          <H3>Automatic worktree creation</H3>
          <P>
            The <strong>Create managed git worktree</strong> checkbox in the
            create dialog is enabled by default. When the working directory
            isn't a git repository, the checkbox disables itself and the
            controls collapse, with a note explaining why.
          </P>
          <P>
            When enabled, Dispatch creates a linked worktree directory, copies{" "}
            <Code>.env</Code> if it exists, and auto-installs dependencies if it
            detects a <Code>pnpm-lock.yaml</Code>, <Code>yarn.lock</Code>,{" "}
            <Code>package-lock.json</Code>, or <Code>bun.lockb</Code>.
          </P>
        </Section>

        <Section>
          <H3>Branch options</H3>
          <P>
            Pick a <strong>Starting branch</strong> from the dropdown — that's
            the branch Dispatch will check out in the worktree. The nested{" "}
            <strong>Create a new branch in this worktree</strong> checkbox
            controls what happens next:
          </P>
          <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
            <li>
              <strong>On (default)</strong> — Dispatch forks a new working
              branch from the starting branch so the agent can make isolated
              changes for later submission. The branch name is auto-generated if
              you leave the field blank. This is the standard authoring flow.
            </li>
            <li>
              <strong>Off</strong> — the worktree checks out the starting branch
              directly. Useful for review or investigation flows where you want
              an isolated working copy of an existing branch without creating a
              new one.
            </li>
          </ul>
          <P>
            The new-branch preference is remembered per working directory, so
            review and authoring repos each keep their own default.
          </P>
        </Section>

        <Section>
          <H3>Worktree location</H3>
          <P>
            By default, worktrees are created next to the repo as siblings (e.g.{" "}
            <Code>../repo-branch-name</Code>). You can change this in{" "}
            <strong>Settings</strong> to place them inside the repo at{" "}
            <Code>.dispatch/worktrees/</Code> instead. Sibling worktrees avoid
            nesting issues with tools that recurse into the repo; nested
            worktrees keep everything under one directory.
          </P>
        </Section>

        <Section>
          <H3>Cleaning up</H3>
          <P>
            When archiving an agent with a worktree, Dispatch checks for
            unmerged commits and uncommitted changes. If the worktree is clean,
            it's removed automatically. If there are outstanding changes, you're
            asked whether to keep the worktree for manual review or remove it.
          </P>
          <P>
            If the worktree was checked out on an existing branch (the
            new-branch checkbox was off), Dispatch removes only the worktree
            directory and leaves the branch alone — it belongs to you, not the
            agent.
          </P>
        </Section>

        <Section>
          <H3>Parallel agents</H3>
          <P>
            Multiple agents can work in the same repo simultaneously. Each uses
            its own worktree with a separate branch and directory, so there are
            no conflicts between concurrent sessions.
          </P>
        </Section>
      </>
    ),
  },
  {
    id: "personas",
    label: "Reviewers",
    icon: Users,
    title: "Reviewers",
    content: (
      <>
        <P>
          Personas are reusable agent roles defined per repository. Each persona
          reviews work from a specific perspective — for example, security, UX,
          or architecture. A persona agent runs as a child of the agent that
          launched it and submits structured feedback.
        </P>

        <Section>
          <H3>How personas work</H3>
          <P>
            An agent calls the built-in <Code>dispatch_launch_persona</Code>{" "}
            tool, passing the persona name and a context briefing. Dispatch
            loads the persona definition from the repo and spawns a new child
            agent with the persona's instructions, the parent's context, and a
            diff of the current branch. The child reviews the work, pings
            progress with <Code>review_status</Code>, submits findings via{" "}
            <Code>dispatch_feedback</Code>, and finishes with{" "}
            <Code>dispatch_complete_review</Code>.
          </P>
          <P>
            Persona agents also have <Code>dispatch_pin</Code> and{" "}
            <Code>dispatch_share</Code> for surfacing files or screenshots, and{" "}
            <Code>get_parent_context</Code> to retrieve the parent agent's pins
            and shared media (for example, a dev server URL to test against).
          </P>
        </Section>

        <Section>
          <H3>Defining personas</H3>
          <P>
            Each repo defines its own personas as markdown files in{" "}
            <Code>.dispatch/personas/</Code>. The filename (without extension)
            becomes the persona slug used when launching. Files use YAML
            frontmatter for metadata and the body is the persona's instructions.
            Dispatch automatically appends the parent agent's context and the
            current diff, plus a standard block of feedback guidance — persona
            files should not include their own context or diff placeholders.
          </P>
          <CodeBlock>{`
# .dispatch/personas/security-review.md
---
name: Security Review
description: Reviews code for security vulnerabilities
feedbackFormat: findings
---

You are a security reviewer. Analyze the changes below for
vulnerabilities, injection risks, and auth issues. Flag only
issues caused or worsened by this diff.`}</CodeBlock>
          <P>
            The <Code>name</Code> and <Code>description</Code> fields are shown
            in the persona picker UI. The <Code>feedbackFormat</Code> field is
            optional and defaults to <Code>findings</Code>.
          </P>
        </Section>

        <Section>
          <H3>Submitting findings</H3>
          <P>
            Persona agents submit findings with the{" "}
            <Code>dispatch_feedback</Code> tool. Each finding includes a
            severity (<Code>critical</Code>, <Code>high</Code>,{" "}
            <Code>medium</Code>, <Code>low</Code>, <Code>info</Code>), a
            description, and optionally a file path, line number, and suggested
            fix. Findings appear in the Feedback panel where you can review and
            resolve them.
          </P>
        </Section>

        <Section>
          <H3>Review lifecycle</H3>
          <P>
            Persona agents ping progress with the <Code>review_status</Code>{" "}
            tool — a short <Code>message</Code> each time the reviewer shifts to
            a distinct phase (e.g. "Reading diff", "Running tests"). To finish,
            they call <Code>dispatch_complete_review</Code> with a{" "}
            <Code>verdict</Code> of <Code>approve</Code> or{" "}
            <Code>request_changes</Code>, a <Code>summary</Code>, and optionally
            a list of <Code>filesReviewed</Code>. The verdict and summary show
            up on the review agent's card in the UI.
          </P>
        </Section>

        <Section>
          <H3>Round-trip reviews</H3>
          <P>
            Parent agents can opt into a single recheck pass by passing{" "}
            <Code>allowRecheck: true</Code> to{" "}
            <Code>dispatch_launch_persona</Code>. The reviewer stays alive after
            its round-1 verdict, waiting for the parent to resolve feedback and
            submit a resolution — then performs a second pass and emits a final
            verdict.
          </P>
          <P>The parent drives the loop with these tools:</P>
          <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
            <li>
              <Code>dispatch_await_review</Code> — wait for the reviewer's next
              state change (still working, round 1 done and feedback is ready,
              whole review complete, or cancelled). Returns a{" "}
              <Code>pollAgainInSeconds</Code> value when pending; trust the
              server's cadence rather than inventing one.
            </li>
            <li>
              <Code>dispatch_get_feedback</Code> — read the findings for a
              specific review.
            </li>
            <li>
              <Code>dispatch_resolve_feedback</Code> — mark each item{" "}
              <Code>fixed</Code> or <Code>ignored</Code>. Ignored items require
              a <Code>reason</Code>; the reviewer sees it on round 2.
            </li>
            <li>
              <Code>dispatch_submit_resolution</Code> — commit your fixes first,
              then submit a 1–3 sentence <Code>summary</Code>. The server
              captures the current HEAD as the resolution commit, and the
              reviewer's round-2 diff is computed from there. Submitting with
              uncommitted changes gives the reviewer an empty diff, and it will
              re-flag the same issues.
            </li>
            <li>
              <Code>dispatch_cancel_recheck</Code> — abort the loop so the
              reviewer exits cleanly.
            </li>
          </ul>
          <P>
            On round 2 the reviewer calls <Code>dispatch_await_recheck</Code> to
            pick up the parent's resolution summary and the round-1 diff,
            performs a second pass, and calls{" "}
            <Code>dispatch_complete_review</Code> a second time with a final
            verdict. Round number, the parent's resolution, and the round-2
            verdict are stacked on the reviewer's card in the UI. The recheck
            wait times out after roughly two hours without a resolution, at
            which point the review is auto-cancelled.
          </P>
        </Section>
      </>
    ),
  },
  {
    id: "events",
    label: "Status Events",
    icon: Signal,
    title: "Status Events",
    content: (
      <>
        <P>
          Agents report their status throughout a task using the{" "}
          <Code>dispatch_event</Code> tool. These events drive the status
          indicators in the sidebar and enable Slack notifications.
        </P>

        <Section>
          <H3>Event types</H3>
          <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
            <li>
              <Code>working</Code> — actively making progress (reading files,
              writing code, running tests)
            </li>
            <li>
              <Code>blocked</Code> — hit an error or obstacle that needs
              resolution
            </li>
            <li>
              <Code>waiting_user</Code> — needs a decision or approval before
              continuing
            </li>
            <li>
              <Code>done</Code> — task is complete
            </li>
            <li>
              <Code>idle</Code> — no meaningful action was taken (e.g. answered
              an informational question)
            </li>
          </ul>
        </Section>

        <Section>
          <H3>How events are used</H3>
          <P>
            Each agent's card in the sidebar shows the latest event's status
            label (Working / Blocked / Waiting / Done / Idle, color-coded), a
            relative timestamp (e.g. "just now", "5m ago"), and the message.
            Events are also stored in the database for activity tracking — the
            Activity page uses them to build heatmaps, working-time breakdowns,
            and daily status charts.
          </P>
        </Section>

        <Section>
          <H3>Configuring agent instructions</H3>
          <P>
            To get agents to report events, add instructions to your repo's{" "}
            <Code>CLAUDE.md</Code> (or equivalent config) telling the agent to
            call <Code>dispatch_event</Code> at key checkpoints: start of turn,
            phase transitions, errors, and before the final response.
          </P>
        </Section>
      </>
    ),
  },
  {
    id: "media",
    label: "Media",
    icon: Image,
    title: "Media & Sharing",
    content: (
      <>
        <P>
          Agents can capture and share screenshots, images, and text files
          during a session. Shared media appears in the Media sidebar for
          review.
        </P>

        <Section>
          <H3>Sharing files</H3>
          <P>
            Agents call the <Code>dispatch_share</Code> tool with a{" "}
            <Code>filePath</Code> and a <Code>description</Code> to publish an
            existing file. Supported formats are PNG, JPG, GIF, WebP, MP4, PDF,
            and a wide range of text file extensions (txt, md, json, yaml, ts,
            py, go, rs, sh, sql, and many others).
          </P>
        </Section>

        <Section>
          <H3>Sharing text snippets</H3>
          <P>
            Instead of writing a scratch file first, agents can pass the text
            directly as <Code>content</Code> along with a <Code>name</Code> that
            has an appropriate extension (e.g. <Code>snippet.ts</Code>). Content
            is capped at 32KB — for anything larger, write the file and use{" "}
            <Code>filePath</Code>.
          </P>
        </Section>

        <Section>
          <H3>Updating shared media</H3>
          <P>
            Every <Code>dispatch_share</Code> call returns a{" "}
            <Code>fileName</Code>. Pass that back as the <Code>update</Code>{" "}
            parameter on a later call to replace the existing file in place
            instead of creating a new entry — useful for iterating on a
            screenshot or snippet without cluttering the sidebar.
          </P>
        </Section>

        <Section>
          <H3>Simulator screenshots</H3>
          <P>
            When <Code>dispatch_share</Code> is called with{" "}
            <Code>source: "simulator"</Code>, it captures a screenshot from the
            iOS Simulator using <Code>xcrun simctl</Code> and shares the
            resulting PNG. <Code>simulatorUdid</Code> selects a specific
            simulator; it defaults to the booted one.
          </P>
        </Section>

        <Section>
          <H3>Screen streaming</H3>
          <P>
            Agents running Playwright can stream their browser session live. The
            stream appears in the media sidebar as a real-time MJPEG feed via
            Chrome DevTools Protocol. When the stream ends, the last frame is
            saved as a screenshot.
          </P>
        </Section>

        <Section>
          <H3>Listing shared media</H3>
          <P>
            Agents can call <Code>dispatch_list_media</Code> to enumerate the
            files they (or the user) have shared in the current session. An
            optional <Code>source</Code> filter narrows the results — e.g.{" "}
            <Code>"user"</Code>, <Code>"screenshot"</Code>, <Code>"text"</Code>,{" "}
            <Code>"simulator"</Code>, or <Code>"stream"</Code>.
          </P>
        </Section>

        <Section>
          <H3>Media sidebar</H3>
          <P>
            Click any agent's media count badge to open the sidebar. Media items
            are shown in reverse chronological order (most recent 50). Click an
            item to open the full-screen lightbox. New items since your last
            visit are marked with a badge.
          </P>
          <P>
            The <strong>Share file</strong> button at the top of the sidebar
            lets you upload a file directly to the agent's media stream (stored
            with <Code>source: "user"</Code>). Tell the agent afterward so it
            knows to look.
          </P>
        </Section>
      </>
    ),
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    title: "Notifications",
    content: (
      <>
        <P>
          Dispatch can notify you when agents finish, need input, or get stuck —
          so you don't have to watch the dashboard. Notifications are delivered
          through three independent channels: native browser notifications,
          Slack, and local sound cues. All three are configured in{" "}
          <strong>Settings → Notifications</strong>.
        </P>

        <Section>
          <H3>Configurable events</H3>
          <P>
            For browser and Slack notifications, you choose which agent status
            changes trigger a notification:
          </P>
          <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
            <li>
              <Code>done</Code> — agent finished its task
            </li>
            <li>
              <Code>waiting_user</Code> — agent needs your input
            </li>
            <li>
              <Code>blocked</Code> — agent hit an error it can't resolve
            </li>
          </ul>
        </Section>

        <Section>
          <H3>Browser notifications</H3>
          <P>
            Grant the browser permission, then toggle{" "}
            <strong>Enable browser notifications</strong>. When the app is open
            in at least one tab, matching events are delivered as native desktop
            or mobile banners instead of Slack. If no tab is open to acknowledge
            the notification within a few seconds, Dispatch falls back to Slack
            automatically.
          </P>
          <P>
            On iOS and iPadOS, notifications only work after installing Dispatch
            as a PWA via <em>Add to Home Screen</em>.
          </P>
        </Section>

        <Section>
          <H3>Slack</H3>
          <P>
            Paste a{" "}
            <a
              href="https://api.slack.com/messaging/webhooks"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline"
            >
              Slack incoming webhook
            </a>{" "}
            URL and use <strong>Send Slack test</strong> to verify it.
            Configured events fire to Slack whenever a browser notification
            isn't delivered (no tab open, permission denied, or the event isn't
            in your browser-notification list).
          </P>
        </Section>

        <Section>
          <H3>Sound cues</H3>
          <P>
            A soft synthesized tone on status changes. Cues are per-device —
            they don't touch server state and only play in tabs where you've
            enabled them. Four cues are available: <Code>done</Code>,{" "}
            <Code>waiting_user</Code>, <Code>blocked</Code>, and a distinct
            chord when a persona reviewer completes its review. Use the preview
            buttons in settings to hear each one.
          </P>
        </Section>

        <Section>
          <H3>Focus-aware suppression</H3>
          <P>
            Dispatch suppresses browser and Slack notifications for an agent
            you're already looking at. Tabs that have an agent selected send
            periodic focus heartbeats while the tab is visible and focused;
            notifications for that agent are dropped until the heartbeat lapses
            (a ~30 second TTL after you switch tabs, change agents, or blur the
            window). Sound cues are not filtered by focus.
          </P>
        </Section>

        <Section>
          <H3>Agent-initiated notifications</H3>
          <P>
            Agents can push a Slack message mid-task by calling the{" "}
            <Code>dispatch_notify</Code> MCP tool — useful for summarizing
            intermediate results, flagging risks, or asking you to check
            something specific. Parameters:
          </P>
          <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
            <li>
              <Code>message</Code> — body with Slack mrkdwn (max 3000 chars).
            </li>
            <li>
              <Code>title</Code> — optional title (max 150 chars). Defaults to{" "}
              <em>Notification from &lt;agent&gt;</em>.
            </li>
            <li>
              <Code>level</Code> — <Code>info</Code>, <Code>success</Code>,{" "}
              <Code>warning</Code>, or <Code>error</Code>; controls the
              attachment color and emoji.
            </li>
            <li>
              <Code>respectFocus</Code> — when <Code>true</Code>, the
              notification is suppressed while you're actively viewing the
              agent. Defaults to <Code>false</Code>.
            </li>
          </ul>
          <P>
            Rate limited to 5 notifications per minute per agent. Requires a
            Slack webhook. Available to regular and job agents; persona agents
            don't have this tool.
          </P>
        </Section>
      </>
    ),
  },
];

function isValidDocsSection(value: string | undefined): value is DocsSection {
  return value !== undefined && SECTIONS.some((s) => s.id === value);
}

/** Lightweight section metadata for sidebar nav (avoids importing heavy content JSX). */
export const DOCS_SECTION_NAV = SECTIONS.map(({ id, label }) => ({
  id,
  label,
}));

type DocsContentProps = {
  initialSection?: string;
  onSectionChange?: (section: string | null) => void;
  title?: string;
};

export function DocsContent({
  initialSection,
  onSectionChange: _onSectionChange,
  title = "Docs",
}: DocsContentProps): JSX.Element {
  const resolvedInitial = isValidDocsSection(initialSection)
    ? initialSection
    : null;
  const [activeSection, setActiveSectionState] = useState<DocsSection | null>(
    resolvedInitial
  );

  useEffect(() => {
    if (isValidDocsSection(initialSection)) {
      setActiveSectionState(initialSection);
    }
  }, [initialSection]);

  const active =
    SECTIONS.find((section) => section.id === activeSection) ?? SECTIONS[0];

  return (
    <div className="flex min-h-0 flex-1 items-stretch">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-6 md:px-8 md:py-8">
            <div className="border-b border-border pb-5">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                  {title}
                </div>
                <h2 className="text-2xl font-semibold tracking-tight">
                  {active.title}
                </h2>
              </div>
            </div>
            <div className="grid gap-6">{active.content}</div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

export function DocsPane({
  open,
  onClose,
  initialSection,
  onSectionChange,
}: DocsPaneProps): JSX.Element {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          data-testid="docs-pane"
          className="fixed inset-0 z-[70] flex flex-col overflow-hidden border border-white/[0.2] bg-[hsl(var(--card))] backdrop-blur-2xl text-foreground shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 md:inset-4 md:rounded-sm"
        >
          <DialogPrimitive.Title className="sr-only">
            Dispatch Docs
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Product documentation for core Dispatch functionality
          </DialogPrimitive.Description>
          <div className="flex h-12 shrink-0 items-center border-b border-border px-5">
            <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Docs
            </span>
            <DialogPrimitive.Close className="ml-auto rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>
          <DocsContent
            initialSection={initialSection}
            onSectionChange={onSectionChange}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
