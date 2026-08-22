import { Code, H3, P, Section } from "./primitives";

export function WorktreesContent() {
  return (
    <>
      <P>
        Git worktrees let agents work in isolation without touching the main
        checkout. Each agent gets its own directory — ideal for parallel tasks,
        review flows, or keeping exploratory work separate.
      </P>

      <Section>
        <H3>Automatic worktree creation</H3>
        <P>
          The <strong>Create managed git worktree</strong> checkbox in the
          create dialog is enabled by default. When the working directory isn't
          a git repository, the checkbox and its controls are disabled, with a
          note explaining why.
        </P>
        <P>
          When enabled, Dispatch creates a linked worktree directory, copies{" "}
          <Code>.env</Code> if it exists, and auto-installs dependencies if it
          detects a <Code>pnpm-lock.yaml</Code>, <Code>yarn.lock</Code>,{" "}
          <Code>package-lock.json</Code>, or <Code>bun.lockb</Code>. Plain
          terminal sessions get the worktree and the <Code>.env</Code> copy but
          skip the dependency install.
        </P>
        <P>
          Templates and jobs run through the same machinery — their{" "}
          <strong>Use worktree</strong>, base branch, and branch name fields
          feed this same creation path, and each launch or run gets its own
          worktree. See <strong>Automations</strong> for those forms.
        </P>
      </Section>

      <Section>
        <H3>When creation fails</H3>
        <P>
          Because you asked for an isolated worktree, Dispatch won't silently
          fall back to running in the main checkout. If the worktree can't be
          created — a name collision, a missing starting branch, or another git
          error — the agent is marked <Code>stopped</Code> with the underlying
          git error in its <strong>Last error</strong>, and its card's status
          line flips to <strong>Blocked</strong> carrying the same message. Any
          partially-created worktree or branch is cleaned up, so fixing the
          cause and relaunching starts from a clean slate.
        </P>
      </Section>

      <Section>
        <H3>Branch options</H3>
        <P>
          Pick a <strong>Starting branch</strong> from the dropdown — that's the
          branch Dispatch will check out in the worktree. The nested{" "}
          <strong>Create a new branch in this worktree</strong> checkbox
          controls what happens next:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <strong>On (default)</strong> — Dispatch forks a new working branch
            from the starting branch so the agent can make isolated changes for
            later submission. The branch name is auto-generated if you leave the
            field blank. This is the standard authoring flow.
          </li>
          <li>
            <strong>Off</strong> — the worktree checks out the starting branch
            directly. Useful for review or investigation flows where you want an
            isolated working copy of an existing branch without creating a new
            one.
          </li>
        </ul>
        <P>
          Either way, Dispatch fetches the starting branch from{" "}
          <Code>origin</Code> first. A new branch forks from the fetched{" "}
          <Code>origin/&lt;starting branch&gt;</Code>, so it starts at the
          latest pushed commit rather than wherever your local checkout is
          sitting; checking out the starting branch directly uses your local
          copy of it. Repos with no <Code>origin</Code> — or no matching remote
          branch — fall back to the local branch.
        </P>
        <P>
          The starting branch and the new-branch preference are both remembered
          per working directory, so review and authoring repos each keep their
          own defaults.
        </P>
      </Section>

      <Section>
        <H3>Worktree location</H3>
        <P>
          By default, worktrees are created next to the repo as siblings (e.g.{" "}
          <Code>../repo-branch-name</Code>). You can change this in{" "}
          <strong>Settings → Agents</strong> to place them inside the repo at{" "}
          <Code>.dispatch/worktrees/</Code> instead. Sibling worktrees avoid
          nesting issues with tools that recurse into the repo; nested worktrees
          keep everything under one directory.
        </P>
        <P>
          The setting covers agents you create yourself and agents launched by
          other agents. Template launches and job runs don&apos;t read it — they
          always land in a sibling directory.
        </P>
      </Section>

      <Section>
        <H3>Cleaning up</H3>
        <P>
          When archiving an agent with a worktree, Dispatch checks for unmerged
          commits and uncommitted changes. If the worktree is clean, it's
          removed automatically. If there are outstanding changes, you're asked
          whether to keep the worktree for manual review or remove it.
        </P>
        <P>
          Removing the worktree also deletes the branch Dispatch created for it.
          On the automatic path that only happens when there was nothing
          unmerged or uncommitted left to lose. Answering{" "}
          <strong>Archive and remove worktree</strong> at the prompt above
          deletes the branch anyway, commits you never pushed included — choose{" "}
          <strong>Archive, keep worktree</strong> if you might still want them.
        </P>
        <P>
          If the worktree was checked out on an existing branch (the new-branch
          checkbox was off), Dispatch removes only the worktree directory and
          leaves the branch alone — it belongs to you, not the agent.
        </P>
      </Section>

      <Section>
        <H3>Parallel agents</H3>
        <P>
          Multiple agents can work in the same repo simultaneously. Each uses
          its own worktree with a separate branch and directory, so there are no
          conflicts between concurrent sessions.
        </P>
      </Section>
    </>
  );
}
