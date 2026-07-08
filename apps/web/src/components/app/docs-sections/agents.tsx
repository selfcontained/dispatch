import { Code, H3, P, Section } from "./primitives";

export function AgentsContent() {
  return (
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
            <Code>codex</Code>, <Code>cursor</Code>, <Code>opencode</Code>) or{" "}
            <Code>terminal</Code> for a plain tmux shell with no CLI attached.
            Disabled types can be enabled in Settings.
          </li>
          <li>
            <strong>Name</strong> — optional display name. Leave it blank and
            the agent picks its own name once it has a sense of the task.
            Terminal agents fall back to a generated name.
          </li>
          <li>
            <strong>Working directory</strong> — path to the repo. Autocompletes
            as you type and validates that the directory exists. Recent
            directories are saved for quick selection.
          </li>
          <li>
            <strong>Create managed git worktree</strong> — checked by default
            (and disabled when the working directory isn't a git repo). Creates
            an isolated worktree so the agent works without touching your
            primary checkout. When checked, two nested controls appear: a{" "}
            <strong>Starting branch</strong> picker (defaults to{" "}
            <Code>main</Code>, remembered per directory) that sets which branch
            the worktree checks out, and a{" "}
            <strong>Create a new branch in this worktree</strong> checkbox that
            controls whether Dispatch forks a new working branch from the
            starting branch (on, default — the authoring flow) or just checks
            out the starting branch directly (off — review/investigation flows).
            When on, a <strong>New branch name</strong> input appears — leave it
            empty and Dispatch auto-generates a name, or type one to use a
            specific branch. See the Worktrees section for details.
          </li>
          <li>
            <strong>Full access mode</strong> (CLI types only) — starts the CLI
            in its most permissive execution mode, so the agent can run commands
            and edit files without confirmation prompts.
          </li>
          <li>
            <strong>Autonomous Review</strong> (CLI types only) — when enabled,
            the agent automatically launches one reviewer agent on completion
            and addresses its feedback before finishing.
          </li>
        </ul>
        <P>
          Click <strong>Create</strong> to start the agent immediately. For CLI
          types, <strong>Create with context</strong> opens a second step where
          you can add startup instructions, attach files, and pin links for the
          new session before launch; terminal agents skip this since there is no
          CLI to send a message to.
        </P>
      </Section>

      <Section>
        <H3>Setup phases</H3>
        <P>
          After creating an agent, the sidebar shows a progress indicator as it
          moves through setup: creating the worktree, copying environment files,
          installing dependencies, and starting the session. Once setup
          completes the agent transitions to <strong>running</strong>.
        </P>
      </Section>

      <Section>
        <H3>Status indicators</H3>
        <P>
          CLI agents in the sidebar show a color-coded status from their latest
          event: green for <strong>working</strong>, red for{" "}
          <strong>blocked</strong>, yellow for <strong>waiting</strong>, and
          blue for <strong>done</strong>. Collapsed cards show the status,
          elapsed time, and the repo or directory name; expand the card to see
          the full event message. Terminal agents have no CLI to emit events, so
          their card stays neutral.
        </P>
      </Section>

      <Section>
        <H3>Sidebar badges</H3>
        <P>
          Three contextual badges can appear next to an agent's name in the
          sidebar:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <strong>Attention</strong> — the agent entered an error state and
            may need manual intervention. Hover the badge to see the specific
            error.
          </li>
          <li>
            <strong>Job</strong> — the agent was spawned by a scheduled or
            on-demand job run.
          </li>
          <li>
            <strong>Update</strong> — the agent is performing an assisted
            Dispatch update.
          </li>
        </ul>
      </Section>

      <Section>
        <H3>Reordering agents</H3>
        <P>
          Drag and drop agent cards in the sidebar to reorder them. The order
          persists across sessions. You can also reorder with the keyboard:
          focus an agent card, then press <Code>Alt+↑</Code> /{" "}
          <Code>Alt+↓</Code> to move it.
        </P>
      </Section>

      <Section>
        <H3>Starting and stopping</H3>
        <P>
          Press the play button to resume a stopped agent. Press the stop button
          to terminate it. Click an agent card to attach your terminal to its
          session, or click again to detach without stopping.
        </P>
      </Section>

      <Section>
        <H3>Sessions are persistent</H3>
        <P>
          The agent runs inside <Code>tmux</Code>, independent of your browser.
          Closing the tab just detaches your terminal view — the agent keeps
          working. Open Dispatch again and click the agent to pick up where you
          left off.
        </P>
      </Section>

      <Section>
        <H3>Agent details</H3>
        <P>
          Expand an agent card to see its metadata. Worktree agents show the
          base branch and working branch (indented below the base); non-worktree
          agents show the working directory and current branch. A{" "}
          <strong>diff-stats badge</strong> in the top-right summarizes
          uncommitted changes against the base branch. CLI agents also show
          whether they're running in full access or sandboxed mode, plus a
          feedback panel and persona launcher; terminal agents skip those since
          they have no CLI. Persona agents show their role and link to their
          parent agent.
        </P>
      </Section>

      <Section>
        <H3>Diff-stats badge</H3>
        <P>
          The <Code>+X −Y</Code> badge in the corner of the expanded card is
          recomputed against the worktree's base branch (defaults to{" "}
          <Code>origin/main</Code>). It is hidden entirely when the agent has no
          changes, briefly highlights when the numbers tick, and dims to ~60%
          opacity when the agent has reported activity since the last compute (a
          hint that the cached value may be stale). Clicking the badge forces a
          fresh recompute; the tooltip shows the file count.
        </P>
      </Section>

      <Section>
        <H3>Changes tab</H3>
        <P>
          The <strong>Changes</strong> tab next to <strong>Terminal</strong> in
          the center pane shows a diff of the agent's uncommitted work against
          its base branch. Each file is syntax-highlighted and can be collapsed
          individually. A file tree sidebar lists all changed files with their
          status (added, modified, deleted) and line counts — click a file to
          scroll to it. Large diffs are truncated by default with a button to
          load the full content.
        </P>
        <P>
          Click the <strong>gear icon</strong> in the tab bar to open diff
          settings. Toggle between <strong>Unified</strong> and{" "}
          <strong>Split</strong> view, and check{" "}
          <strong>Hide whitespace changes</strong> to filter out whitespace-only
          edits. These settings persist across sessions. On mobile, the diff
          always renders in unified mode.
        </P>
        <P>
          Select one or more lines in a diff, then click the comment icon to
          leave a note for the agent. The comment is injected into the agent's
          terminal with the file path and line range so the agent can act on it
          immediately.
        </P>
      </Section>

      <Section>
        <H3>Tmux scrollback</H3>
        <P>
          Attaching to an agent puts you in tmux's live mode. When you scroll up
          (or otherwise enter tmux copy mode), Dispatch shows an{" "}
          <em>Input paused — scroll · click · Esc</em> banner over the terminal.
          Clicking the banner or pressing <Code>Esc</Code> drops you back to
          live so your next keystroke goes to the agent.
        </P>
      </Section>

      <Section>
        <H3 id="quick-phrases">Quick Phrases</H3>
        <P>
          The <strong>Quick Phrases</strong> button (speech-bubble icon) in the
          terminal top rail lets you save reusable text snippets and inject them
          into agent sessions. Phrases are always available for management; the
          inject action is enabled when you're connected to an agent session.
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <strong>Creating</strong> — click the <Code>+</Code> button in the
            popover to open the Add Phrase dialog. Each phrase has an optional{" "}
            <strong>Label</strong> (short display name) and the{" "}
            <strong>Phrase text</strong> that gets injected.
          </li>
          <li>
            <strong>Variables</strong> — use{" "}
            <Code>{"{{D:Variable Name}}"}</Code> placeholders in the phrase
            text. Add <Code>|required</Code> or <Code>|multiline</Code>{" "}
            modifiers after the name (same syntax as Templates). When injecting
            a phrase with variables, a fill-in dialog appears first.
          </li>
          <li>
            <strong>Injecting</strong> — phrases without variables show a split
            button: <strong>Send</strong> pastes the text and submits it; the
            dropdown offers <strong>Paste without submitting</strong> which
            pastes only. Phrases with variables show a <strong>Send…</strong>{" "}
            button that opens the fill-in dialog.
          </li>
          <li>
            <strong>Editing and deleting</strong> — each phrase row has edit and
            delete buttons. Deleting prompts for confirmation.
          </li>
        </ul>
      </Section>

      <Section>
        <H3>Renaming agents</H3>
        <P>
          Agents created without an explicit name start with a placeholder (
          <Code>agent-&lt;last6&gt;</Code>). The first time the agent
          transitions into a working state, Dispatch automatically sends a
          prompt asking it to set a descriptive session name via the{" "}
          <Code>dispatch_rename_session</Code> tool. You can also trigger this
          manually by clicking the <strong>Tag</strong> icon that appears next
          to a running agent that still has a default name. Terminal agents,
          persona agents, and job agents are excluded from both paths.
        </P>
        <P>
          To rename any agent yourself, expand its sidebar card and click the
          edit button to open the <strong>Session settings</strong> dialog and
          type a new name.
        </P>
      </Section>

      <Section>
        <H3>Archiving agents</H3>
        <P>
          Click the archive button to remove an agent. If the agent has a
          worktree with unmerged commits or uncommitted changes, you'll be asked
          whether to keep or remove the worktree. Archived agents are preserved
          in the History section of the Activity page, where you can review
          their events, media, pins, and feedback.
        </P>
      </Section>

      <Section>
        <H3>Agent orchestration</H3>
        <P>
          Agents can launch other agents using the{" "}
          <Code>dispatch_launch_agent</Code> tool. The child agent runs
          independently and appears as a top-level entry in the sidebar — it
          inherits the parent's working directory and full-access mode by
          default. Each child is told which agent launched it and can coordinate
          back using <Code>dispatch_send_message</Code>.
        </P>
        <P>
          Archiving a parent does not archive its launched children — they
          continue running on their own. This differs from persona reviewers,
          which are always archived alongside their parent.
        </P>
      </Section>

      <Section>
        <H3>Reordering agents</H3>
        <P>
          Drag and drop agent cards in the sidebar to reorder them. You can also
          focus a card and press <Code>Alt+↑</Code> or <Code>Alt+↓</Code> to
          move it. The custom order is saved per session.
        </P>
      </Section>
    </>
  );
}
