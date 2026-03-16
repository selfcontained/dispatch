import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowLeft, ChevronRight, GitBranch, Monitor, PlugZap, X } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type DocsSection = "agents" | "tools" | "worktrees";

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
            Click <strong>Create</strong> in the sidebar. Pick a name, choose
            the CLI (<Code>claude</Code>, <Code>codex</Code>,
            or <Code>opencode</Code>), and set the working directory to your
            repo. The working directory determines which repo tools and
            instruction files the agent loads.
          </P>
        </Section>

        <Section>
          <H3>Starting and stopping</H3>
          <P>
            Press <strong>Start</strong> to launch the agent in
            a <Code>tmux</Code> session on the server.
            Press <strong>Stop</strong> to terminate it. You can also
            use <strong>Attach</strong> to reconnect to a session that's
            already running, or <strong>Detach</strong> to disconnect your
            terminal without stopping the agent.
          </P>
        </Section>

        <Section>
          <H3>Sessions are persistent</H3>
          <P>
            The agent runs inside <Code>tmux</Code>, independent of your
            browser. Closing the tab just detaches your terminal view — the
            agent keeps working. Open Dispatch again and attach to pick up
            where you left off.
          </P>
        </Section>

        <Section>
          <H3>Full access mode</H3>
          <P>
            When creating an agent, you can enable <strong>full access
            mode</strong>. This starts the CLI in its most permissive
            execution mode, so the agent can run commands and edit files
            without confirmation prompts.
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
          </ul>
        </Section>

        <Section>
          <H3>Environment</H3>
          <P>
            Repo tool commands receive <Code>DISPATCH_AGENT_ID</Code> in their
            environment, so scripts can scope resources (databases, temp
            directories, ports) per agent.
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
          Agents can use git worktrees to work on changes in isolation without
          affecting the main checkout. This is useful for parallel tasks or
          keeping exploratory work separate.
        </P>

        <Section>
          <H3>Creating a worktree</H3>
          <P>
            Agents call the built-in <Code>create_worktree</Code> tool. It
            creates a new branch and a linked worktree directory, then the
            agent <Code>cd</Code>s into it.
          </P>
          <CodeBlock>{`
# What the agent does behind the scenes:
git worktree add -b fix-auth ../project-fix-auth main
cd ../project-fix-auth`}</CodeBlock>
          <P>
            The worktree is a full copy of the repo on its own branch. The
            agent can make commits, run tests, and open PRs from there without
            touching the primary checkout.
          </P>
        </Section>

        <Section>
          <H3>Cleaning up</H3>
          <P>
            When the work is done, the agent
            calls <Code>cleanup_worktree</Code> to remove the linked directory
            and optionally delete the branch.
          </P>
        </Section>

        <Section>
          <H3>Parallel agents</H3>
          <P>
            Multiple agents can work in the same repo simultaneously by using
            separate worktrees. Each agent operates on its own branch and
            directory, so there are no conflicts between concurrent sessions.
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
