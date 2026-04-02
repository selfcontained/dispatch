import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  Bell,
  ChevronRight,
  GitBranch,
  Image,
  Monitor,
  PlugZap,
  Signal,
  Users,
  X,
} from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type DocsSection = "agents" | "tools" | "worktrees" | "personas" | "events" | "media" | "notifications";

type DocsPaneProps = {
  open: boolean;
  onClose: () => void;
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
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>;
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="text-base font-semibold text-foreground">{children}</h3>;
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
            <li><strong>Type</strong> — choose the CLI: <Code>claude</Code>, <Code>codex</Code>, or <Code>opencode</Code>. Disabled types can be enabled in Settings.</li>
            <li><strong>Name</strong> — optional display name for the agent.</li>
            <li><strong>Working directory</strong> — path to the repo. Autocompletes as you type and validates that the directory exists. Recent directories are saved for quick selection.</li>
            <li><strong>Create git worktree</strong> — checked by default. Creates an isolated worktree so the agent works on its own branch without touching your primary checkout. When enabled, you can pick a base branch and optionally set a custom branch name.</li>
            <li><strong>Full access mode</strong> — starts the CLI in its most permissive execution mode, so the agent can run commands and edit files without confirmation prompts.</li>
          </ul>
        </Section>

        <Section>
          <H3>Setup phases</H3>
          <P>
            After creating an agent, the sidebar shows a progress indicator
            as it moves through setup: creating the worktree, copying
            environment files, installing dependencies, and starting the
            session. Once setup completes the agent transitions
            to <strong>running</strong>.
          </P>
        </Section>

        <Section>
          <H3>Status indicators</H3>
          <P>
            Each agent in the sidebar shows a color-coded status from its
            latest event: blue for <strong>working</strong>, red
            for <strong>blocked</strong>, yellow
            for <strong>waiting</strong>, and green
            for <strong>done</strong>. The sidebar also shows the event
            message and how long ago it was reported.
          </P>
        </Section>

        <Section>
          <H3>Starting and stopping</H3>
          <P>
            Press the play button to resume a stopped agent. Press the
            stop button to terminate it. Click an agent's name to attach
            your terminal to its session, or click again to detach without
            stopping.
          </P>
        </Section>

        <Section>
          <H3>Sessions are persistent</H3>
          <P>
            The agent runs inside <Code>tmux</Code>, independent of your
            browser. Closing the tab just detaches your terminal view — the
            agent keeps working. Open Dispatch again and click the agent to
            pick up where you left off.
          </P>
        </Section>

        <Section>
          <H3>Agent details</H3>
          <P>
            Expand an agent card to see its metadata: working directory or
            worktree path, git branch, agent type, and whether it's running
            in full access or sandboxed mode. Persona agents show their
            role and link to their parent agent.
          </P>
        </Section>

        <Section>
          <H3>Archiving agents</H3>
          <P>
            Click the archive button to remove an agent. If the agent has a
            worktree with unmerged commits or uncommitted changes, you'll be
            asked whether to keep or remove the worktree. Archived agents
            are preserved in the History section of the Activity page.
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
          Repos can register custom MCP tools that agents call during a
          session. Tools are defined in <Code>.dispatch/tools.json</Code> at
          the repo root.
        </P>

        <Section>
          <H3>Defining tools</H3>
          <P>
            Each tool has a name, a description, and a command to run.
            Dispatch automatically prefixes tool names with <Code>repo.</Code>{" "}
            when exposing them to agents. The command executes in the repo root
            when called.
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
            The tools above would be available to agents
            as <Code>repo.lint</Code>, <Code>repo.test</Code>,
            and <Code>repo.db_reset</Code>.
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
            When an agent calls <Code>repo.dev_up</Code> with{" "}
            <Code>{"{ cwd: \"/path\", live: true }"}</Code>, Dispatch
            runs <Code>./bin/dev up --cwd /path --live</Code>.
            Parameters that are omitted or false are skipped.
          </P>
        </Section>

        <Section>
          <H3>Built-in tools</H3>
          <P>
            Dispatch also provides built-in tools that are always available,
            regardless of repo configuration:
          </P>
          <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
            <li><Code>create_worktree</Code> — create an isolated git worktree for parallel work</li>
            <li><Code>cleanup_worktree</Code> — remove a worktree when done</li>
            <li><Code>create_pr</Code> — open a pull request from the current branch</li>
            <li><Code>get_pr_status</Code> — check CI status on a pull request</li>
            <li><Code>merge_pr_now</Code> — merge a pull request</li>
            <li><Code>enable_pr_automerge</Code> — auto-merge a PR when checks pass</li>
            <li><Code>dispatch_event</Code> — report agent status (working, blocked, done)</li>
            <li><Code>dispatch_share</Code> — publish a screenshot or image to the session's media stream</li>
            <li><Code>dispatch_feedback</Code> — submit a structured finding with severity, file reference, and suggestion</li>
            <li><Code>dispatch_get_feedback</Code> — retrieve feedback findings for the current session</li>
            <li><Code>dispatch_launch_persona</Code> — launch a persona agent as a child of the current session</li>
          </ul>
        </Section>

        <Section>
          <H3>Lifecycle hooks</H3>
          <P>
            Repos can define lifecycle hooks
            in <Code>.dispatch/tools.json</Code> that run automatically at key
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
            Agent sessions run inside tmux (non-login, non-interactive),
            so standard shell profiles are <strong>not</strong> sourced.
            If agents need tools like <Code>nvm</Code>, <Code>pyenv</Code>,
            or tokens like <Code>GH_TOKEN</Code>, add them
            to <Code>~/.dispatch/env</Code>:
          </P>
          <CodeBlock>{`# ~/.dispatch/env
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export GH_TOKEN="ghp_..."`}</CodeBlock>
          <P>
            Repo tool commands and hooks also
            receive <Code>DISPATCH_AGENT_ID</Code> in their environment, so
            scripts can scope resources (databases, temp directories, ports) per
            agent.
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
          Git worktrees let agents work on changes in isolation without
          touching the main checkout. Each agent gets its own branch and
          directory — ideal for parallel tasks or keeping exploratory work
          separate.
        </P>

        <Section>
          <H3>Automatic worktree creation</H3>
          <P>
            When creating an agent, the <strong>Create git worktree</strong>{" "}
            checkbox is enabled by default. Dispatch creates a new branch
            and linked worktree directory, copies environment files
            (like <Code>.env</Code>), and starts the agent inside it. You
            can choose a base branch and optionally set a custom branch name
            in the create dialog.
          </P>
        </Section>

        <Section>
          <H3>On-demand worktrees</H3>
          <P>
            Agents can also create worktrees during a session by calling
            the <Code>create_worktree</Code> tool. This is useful when an
            agent decides mid-task that it needs isolation.
          </P>
          <CodeBlock>{`
# What happens behind the scenes:
git worktree add -b fix-auth ../project-fix-auth main
cd ../project-fix-auth`}</CodeBlock>
        </Section>

        <Section>
          <H3>Worktree location</H3>
          <P>
            By default, worktrees are created inside the repo
            at <Code>.dispatch/worktrees/</Code>. You can change this
            in <strong>Settings</strong> to place them next to the repo
            instead (as siblings). This is useful if your tooling doesn't
            work well with nested worktrees.
          </P>
        </Section>

        <Section>
          <H3>Cleaning up</H3>
          <P>
            When archiving an agent with a worktree, Dispatch checks for
            unmerged commits and uncommitted changes. If the worktree is
            clean, it's removed automatically. If there are outstanding
            changes, you're asked whether to keep the worktree for manual
            review or remove it. Agents can also
            call <Code>cleanup_worktree</Code> directly to remove a
            worktree during a session.
          </P>
        </Section>

        <Section>
          <H3>Parallel agents</H3>
          <P>
            Multiple agents can work in the same repo simultaneously. Each
            uses its own worktree with a separate branch and directory, so
            there are no conflicts between concurrent sessions.
          </P>
        </Section>
      </>
    ),
  },
  {
    id: "personas",
    label: "Personas",
    icon: Users,
    title: "Personas",
    content: (
      <>
        <P>
          Personas are reusable agent roles defined per repository. Each
          persona reviews work from a specific perspective — for example,
          security, UX, or architecture. A persona agent runs as a child of
          the agent that launched it and submits structured feedback.
        </P>

        <Section>
          <H3>How personas work</H3>
          <P>
            An agent calls the built-in <Code>dispatch_launch_persona</Code>{" "}
            tool, passing the persona name and a context briefing. Dispatch
            loads the persona definition from the repo, spawns a new child
            agent with the persona's instructions and a diff of the current
            branch, and the child reviews the work and submits findings
            via <Code>dispatch_feedback</Code>.
          </P>
        </Section>

        <Section>
          <H3>Defining personas</H3>
          <P>
            Each repo defines its own personas as markdown files
            in <Code>.dispatch/personas/</Code>. The filename (without
            extension) becomes the persona slug used when launching. Files
            use YAML frontmatter for metadata and the body contains
            instructions with <Code>{"{{context}}"}</Code>{" "}
            and <Code>{"{{diff}}"}</Code> placeholders that Dispatch fills
            in at launch time.
          </P>
          <CodeBlock>{`
# .dispatch/personas/security-review.md
---
name: Security Review
description: Reviews code for security vulnerabilities
feedbackFormat: findings
---

You are a security reviewer. Analyze the following changes
for vulnerabilities, injection risks, and auth issues.

## Context
{{context}}

## Diff
{{diff}}`}</CodeBlock>
          <P>
            The <Code>name</Code> and <Code>description</Code> fields are
            shown in the persona picker UI. The <Code>feedbackFormat</Code>{" "}
            field is optional and defaults to <Code>findings</Code>.
          </P>
        </Section>

        <Section>
          <H3>Feedback findings</H3>
          <P>
            Persona agents submit findings with
            the <Code>dispatch_feedback</Code> tool. Each finding includes a
            severity (<Code>critical</Code>, <Code>high</Code>,{" "}
            <Code>medium</Code>, <Code>low</Code>, <Code>info</Code>),
            a description, and optionally a file path, line number, and
            suggested fix. Findings appear in the Feedback panel where you can
            review and resolve them.
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
          Agents report their status throughout a task using
          the <Code>dispatch_event</Code> tool. These events drive the status
          indicators in the sidebar and enable Slack notifications.
        </P>

        <Section>
          <H3>Event types</H3>
          <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
            <li><Code>working</Code> — actively making progress (reading files, writing code, running tests)</li>
            <li><Code>blocked</Code> — hit an error or obstacle that needs resolution</li>
            <li><Code>waiting_user</Code> — needs a decision or approval before continuing</li>
            <li><Code>done</Code> — task is complete</li>
            <li><Code>idle</Code> — no meaningful action was taken (e.g. answered an informational question)</li>
          </ul>
        </Section>

        <Section>
          <H3>How events are used</H3>
          <P>
            The agent sidebar shows the latest event message and a color-coded
            status indicator for each agent. Events are also stored in the
            database for activity tracking — the Activity page uses them
            to build heatmaps, working-time breakdowns, and daily status charts.
          </P>
        </Section>

        <Section>
          <H3>Configuring agent instructions</H3>
          <P>
            To get agents to report events, add instructions to your
            repo's <Code>CLAUDE.md</Code> (or equivalent config) telling the
            agent to call <Code>dispatch_event</Code> at key checkpoints:
            start of turn, phase transitions, errors, and before the final
            response.
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
          <H3>Sharing media</H3>
          <P>
            Agents call the <Code>dispatch_share</Code> tool to publish media.
            It accepts a file path or raw text content, along with a
            description. Supported formats include PNG, JPG, GIF, WebP
            images, MP4 video, and text files.
          </P>
        </Section>

        <Section>
          <H3>Simulator screenshots</H3>
          <P>
            When <Code>dispatch_share</Code> is called
            with <Code>source: "simulator"</Code>, it automatically captures
            a screenshot from the iOS Simulator using <Code>xcrun simctl</Code>.
            This is useful for agents validating mobile UI changes.
          </P>
        </Section>

        <Section>
          <H3>Screen streaming</H3>
          <P>
            Agents running Playwright can stream their browser session live.
            The stream appears in the media sidebar as a real-time MJPEG feed
            via Chrome DevTools Protocol. When the stream ends, the last frame
            is saved as a screenshot.
          </P>
        </Section>

        <Section>
          <H3>Media sidebar</H3>
          <P>
            Click any agent's media count badge to open the sidebar. Media
            items are shown in reverse chronological order. Click an item
            to open the full-screen lightbox. New items since your last
            visit are marked with a badge.
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
          Dispatch can send Slack notifications when agents need attention or
          finish their work, so you don't have to watch the dashboard.
        </P>

        <Section>
          <H3>Setting up Slack</H3>
          <P>
            Go to <strong>Settings → Notifications</strong> and paste a Slack
            incoming webhook URL. Use the <strong>Send test</strong> button to
            verify the integration works.
          </P>
        </Section>

        <Section>
          <H3>Configurable events</H3>
          <P>
            You can choose which agent events trigger a notification:
          </P>
          <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
            <li><Code>done</Code> — agent finished its task</li>
            <li><Code>waiting_user</Code> — agent needs your input</li>
            <li><Code>blocked</Code> — agent hit an error it can't resolve</li>
          </ul>
        </Section>

        <Section>
          <H3>Focus-aware suppression</H3>
          <P>
            Dispatch tracks whether you're actively viewing an agent. If you
            have the agent's terminal open, notifications for that agent are
            suppressed — you'll only get notified for agents you're not
            watching.
          </P>
        </Section>
      </>
    ),
  },
];

export function DocsPane({ open, onClose }: DocsPaneProps): JSX.Element {
  const [activeSection, setActiveSection] = useState<DocsSection | null>("agents");
  const active = SECTIONS.find((section) => section.id === activeSection) ?? SECTIONS[0];

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) {
          onClose();
          setActiveSection("agents");
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          data-testid="docs-pane"
          className="fixed inset-0 z-[70] flex flex-col overflow-hidden border border-border bg-card text-foreground shadow-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 md:inset-4 md:rounded-sm"
        >
          <DialogPrimitive.Title className="sr-only">Dispatch Docs</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Product documentation for core Dispatch functionality
          </DialogPrimitive.Description>

          <div className="flex h-12 shrink-0 items-center border-b border-border px-5">
            {activeSection !== null ? (
              <button
                onClick={() => setActiveSection(null)}
                className="mr-2 rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 md:hidden"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            ) : null}
            <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {activeSection !== null ? <span className="md:hidden">{active.label}</span> : null}
              <span className={activeSection !== null ? "hidden md:inline" : ""}>Docs</span>
            </span>
            <DialogPrimitive.Close className="ml-auto rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>

          <div className="flex min-h-0 flex-1">
            <nav className="hidden w-56 shrink-0 flex-col border-r border-border py-2 md:flex">
              {SECTIONS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveSection(id)}
                  className={cn(
                    "flex items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors",
                    activeSection === id ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  {label}
                </button>
              ))}
            </nav>

            {activeSection === null ? (
              <nav className="flex flex-1 flex-col md:hidden">
                {SECTIONS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setActiveSection(id)}
                    className="flex items-center gap-3 border-b border-border px-5 py-3.5 text-sm text-foreground transition-colors active:bg-muted"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    {label}
                    <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
                  </button>
                ))}
              </nav>
            ) : null}

            <div className={cn("min-h-0 min-w-0 flex-1", activeSection === null && "hidden md:block")}>
              <ScrollArea className="h-full">
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-6 md:px-8 md:py-8">
                  <div className="border-b border-border pb-5">
                    <h2 className="text-2xl font-semibold tracking-tight">{active.title}</h2>
                  </div>
                  <div className="grid gap-6">
                    {active.content}
                  </div>
                </div>
              </ScrollArea>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
