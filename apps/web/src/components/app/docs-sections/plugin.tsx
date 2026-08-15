import { Code, CodeBlock, H3, P, Section } from "./primitives";

export function PluginContent() {
  return (
    <>
      <P>
        Dispatch publishes an official plugin for <strong>Claude Code</strong>{" "}
        and <strong>Codex</strong>. It ships skills that teach agents how to use
        the capabilities documented here — the Brain, subagents, repo tools,
        artifact sharing, the review workflow, the whiteboard, jobs, templates,
        reviewers, personalities, and UI validation — so an agent discovers them
        at the moment it needs one instead of having to be told. The Dispatch
        repo doubles as the marketplace it's served from.
      </P>

      <Section>
        <H3 id="plugin-trust">Before you install</H3>
        <P>
          Plugins on both platforms are{" "}
          <strong>
            unsigned and unsandboxed, and run with your full local user
            privileges
          </strong>{" "}
          — this one and every other plugin you install from a self-hosted
          marketplace. This plugin ships no executable components: no hooks, no{" "}
          <Code>bin/</Code>, no bundled MCP servers, no LSP servers. Everything
          it contributes is markdown that agents read. After install,{" "}
          <Code>claude plugin details dispatch@dispatch</Code> prints a
          component inventory that should read <Code>Hooks (0)</Code>,{" "}
          <Code>MCP servers (0)</Code>, and <Code>LSP servers (0)</Code>.
        </P>
      </Section>

      <Section>
        <H3 id="plugin-install">Installing</H3>
        <P>
          Installing from a marketplace is two steps on both platforms: register
          the catalog, then install the plugin from it. Adding the marketplace
          installs nothing on its own.
        </P>
        <P>
          <strong>Claude Code</strong> — from inside a session:
        </P>
        <CodeBlock>{`/plugin marketplace add selfcontained/dispatch
/plugin install dispatch@dispatch`}</CodeBlock>
        <P>
          The same two steps run non-interactively as{" "}
          <Code>claude plugin marketplace add selfcontained/dispatch</Code> and{" "}
          <Code>claude plugin install dispatch@dispatch</Code>. That form
          doesn't run inside a session, so the skills load the next time you
          start Claude Code — or immediately if you run{" "}
          <Code>/reload-plugins</Code> in a session that's already open.
        </P>
        <P>
          <strong>Codex</strong> — <Code>codex plugin add</Code> installs from a
          configured marketplace snapshot, so the marketplace step is required
          here too. <Code>/plugins</Code> inside a Codex session opens the same
          catalog as a browser.
        </P>
        <CodeBlock>{`codex plugin marketplace add selfcontained/dispatch
codex plugin add dispatch@dispatch`}</CodeBlock>
      </Section>

      <Section>
        <H3 id="plugin-skills">What's in it</H3>
        <P>
          Eleven narrow skills, each written to fire on a situation rather than
          a feature name — an agent that doesn't know a capability exists will
          never match its name, but will match a description of the spot it's
          currently in.
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <Code>brain</Code> — something needs to outlive the session or reach
            another agent
          </li>
          <li>
            <Code>subagents</Code> — work should be delegated, or another agent
            needs coordinating
          </li>
          <li>
            <Code>repo-tools</Code> — a repo script should become a first-class
            tool
          </li>
          <li>
            <Code>sharing</Code> — an artifact needs to reach the user
          </li>
          <li>
            <Code>review-workflow</Code> — a PR is going up, or review feedback
            needs working
          </li>
          <li>
            <Code>ui-validation</Code> — a UI change needs proving in a browser
          </li>
          <li>
            <Code>personas</Code> — this repo needs a reviewer with a domain
            lens
          </li>
          <li>
            <Code>whiteboard</Code> — the user's sketch matters, or a diagram
            beats prose
          </li>
          <li>
            <Code>jobs</Code> — work should run on a schedule and report
            structurally
          </li>
          <li>
            <Code>templates</Code> — a launch configuration is worth saving
          </li>
          <li>
            <Code>personalities</Code> — the user is commenting on how agents
            talk
          </li>
        </ul>
        <P>
          Status reporting, pin discipline, and session naming are deliberately
          not skills — they're always relevant, and skills only load on a task
          match, so those stay in the launch guidance Dispatch injects into
          every agent.
        </P>
      </Section>

      <Section>
        <H3 id="plugin-updating">Keeping it updated</H3>
        <P>
          The plugin carries an explicit version in its manifests, so updates
          only ship when that version is bumped — routine commits to the repo
          don't register as a plugin update.
        </P>
        <P>
          <strong>Claude Code</strong> — run{" "}
          <Code>claude plugin update dispatch@dispatch</Code>, or{" "}
          <Code>/plugin marketplace update dispatch</Code> first to refresh the
          catalog. Auto-update is off by default for third-party marketplaces
          like this one; turn it on per-marketplace under <Code>/plugin</Code> →{" "}
          <strong>Marketplaces</strong>.
        </P>
        <P>
          <strong>Codex</strong> — there is no update subcommand. Re-run{" "}
          <Code>codex plugin add dispatch@dispatch</Code> to upgrade; it
          replaces the cached copy.{" "}
          <Code>codex plugin marketplace upgrade</Code> only refreshes the
          catalog snapshot, not the installed plugin, and{" "}
          <Code>codex plugin list</Code> won't tell you a newer version exists.
        </P>
      </Section>
    </>
  );
}
