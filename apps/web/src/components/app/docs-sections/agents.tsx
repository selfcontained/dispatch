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
            <strong>Type</strong> — <Code>claude</Code> (the default) or{" "}
            <Code>codex</Code>. Disabled types can be enabled in Settings.
          </li>
          <li>
            <strong>Model</strong> — shown for CLI types with a curated model
            catalog (<Code>claude</Code>, <Code>codex</Code>). Pin the agent to
            a specific model, or leave <strong>Default</strong> to use the CLI's
            own setting. The choice sticks with the agent and is reused when it
            resumes.
          </li>
          <li>
            <strong>Name</strong> — optional display name. Leave it blank and
            the agent picks its own name once it has a sense of the task.
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
            primary checkout. Two nested controls sit under it, dimmed and
            disabled until it's checked: a <strong>Starting branch</strong>{" "}
            picker (defaults to <Code>main</Code>) that sets which branch the
            worktree checks out, and a{" "}
            <strong>Create a new branch in this worktree</strong> checkbox that
            controls whether Dispatch forks a new working branch from the
            starting branch (on, default — the authoring flow) or just checks
            out the starting branch directly (off — review/investigation flows).
            The <strong>New branch name</strong> input below it follows the same
            pattern, active only while that checkbox is on — leave it empty and
            Dispatch auto-generates a name, or type one to use a specific
            branch. See the Worktrees section for details.
          </li>
          <li>
            <strong>Full access mode</strong> (CLI types only) — starts the CLI
            in its most permissive execution mode, so the agent can run commands
            and edit files without confirmation prompts.
          </li>
          <li>
            <strong>Autonomous Review</strong> (CLI types only) — when enabled,
            the agent automatically launches one reviewer persona on completion
            and works its review block&apos;s findings before finishing.
          </li>
        </ul>
        <P>
          The form reopens with the choices you last made in that working
          directory: full access, Autonomous Review, the starting branch, and
          the new-branch checkbox are remembered per directory, and the model
          per directory and agent type.
        </P>
        <P>
          Click <strong>Create</strong> to start the agent immediately.{" "}
          <strong>Create with context</strong> opens a second step where you can
          add startup instructions, attach files, and add links for the new
          session before launch.
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
          Agents in the sidebar show a color-coded status derived from their
          stream: green for <strong>working</strong> (a turn is running), red
          for <strong>blocked</strong> (the turn ended in an error), yellow for{" "}
          <strong>waiting</strong> (an open question or form for you), and idle
          otherwise. Collapsed cards show the status, elapsed time, and the repo
          or directory name; expand the card to see the full status line.
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
            on-demand job run. For a Loop job it shows as <strong>Loop</strong>{" "}
            instead, and its tooltip names the current iteration (and the run
            limit, if one is set).
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
          Press the play button on a stopped agent's row to resume it. To stop a
          running agent, expand its card and press the pause button in the
          footer — a confirmation dialog appears first, and you can resume the
          session later. Click an agent card to open its Chat; a stopped
          agent&apos;s Chat stays readable.
        </P>
      </Section>

      <Section>
        <H3>Sessions are persistent</H3>
        <P>
          The agent runs in its own host process, independent of your browser
          and of the Dispatch server. Closing the tab — or restarting Dispatch —
          does not stop it. Open Dispatch again and click the agent to pick up
          where you left off.
        </P>
      </Section>

      <Section>
        <H3>Agent details</H3>
        <P>
          Expand an agent card to see its metadata. Worktree agents show the
          base branch and working branch (indented below the base); non-worktree
          agents show the working directory and current branch. A{" "}
          <strong>diff-stats badge</strong> in the top-right summarizes
          uncommitted changes against the base branch. The details card also has
          a button to open the working directory in your IDE and, for worktree
          agents, a pill that copies the worktree path, a{" "}
          <strong>Full access</strong> pill when the agent was launched with the
          engine&apos;s permission prompts off, and a <strong>Review</strong>{" "}
          button that launches one or more personas (see the Reviewers section —
          a reviewer&apos;s findings live in its review block in the Chat, not
          on the card). Agents launched as children — persona agents included —
          appear in a <strong>Sub Agents</strong> list in the expanded card.
        </P>
      </Section>

      <Section>
        <H3>Diff-stats badge</H3>
        <P>
          The <Code>+X −Y</Code> badge in the corner of the expanded card is
          recomputed against the worktree's base branch (defaults to{" "}
          <Code>origin/main</Code>). It is hidden entirely when the agent has no
          changes, briefly highlights when the numbers tick, and dims to ~60%
          opacity once the agent has reported activity since the last compute
          and that compute is over 30 seconds old (a hint that the cached value
          may be stale). Clicking the badge forces a fresh recompute; the
          tooltip shows the file count.
        </P>
      </Section>

      <Section>
        <H3 id="split-tabs">Changes tab</H3>
        <P>
          The <strong>Changes</strong> tab next to <strong>Agent</strong> in the
          center pane shows a diff of the agent's uncommitted work against its
          base branch, with any review findings placed at the lines they name.
          Each file is syntax-highlighted and can be collapsed individually. A
          file tree sidebar lists all changed files with their status (added,
          modified, deleted) and line counts — click a file to scroll to it.
          Large diffs are truncated by default with a button to load the full
          content.
        </P>
        <P>
          Click the <strong>gear icon</strong> in the tab bar to open diff
          settings. Toggle between <strong>Unified</strong> and{" "}
          <strong>Split</strong> view, choose whether to{" "}
          <strong>Include uncommitted changes</strong>, check{" "}
          <strong>Hide whitespace changes</strong> to filter out whitespace-only
          edits, and check <strong>Hide test files</strong> to filter
          conventional test files out of the diff and file tree (a file you
          navigate to directly stays visible even if it's a test). Excluding
          uncommitted changes limits the diff and its stats to committed work.
          These settings persist across sessions. On mobile, the diff always
          renders in unified mode.
        </P>
        <P>
          On desktop, drag any center-pane tab onto the left or right side of
          the pane to split the workspace. Split panes let you keep the Chat and
          the diff visible together, resize them with the center handle, and
          return to a single pane with the unsplit control.
        </P>
        <P>
          A toolbar above the diff carries the two ways to get the work
          reviewed. <strong>Launch personas</strong> starts one or more persona
          agents as children of this agent — pick the personas, agent type and
          model, add a focus note, and choose whether the briefing includes the
          current diff (see the Reviewers section).{" "}
          <strong>Leave a review</strong> enters review mode for a review by
          hand.
        </P>
        <P>
          Select one or more lines in a diff, then click the comment icon to
          leave feedback. The primary action is <strong>Start a review</strong>,
          which enters review mode and saves the comment as a draft. Use the
          dropdown to pick <strong>Chat</strong> instead — that sends the
          comment to the agent as a one-off message.
        </P>
        <P>
          In review mode, a bar at the top shows your draft count and a{" "}
          <strong>Post review</strong> button. Keep adding draft comments across
          different files, then post them all at once with a verdict and a
          summary; each comment can be given a severity in the dialog. The
          result is a <Code>review</Code> block in the agent&apos;s stream,
          addressed to the agent, with one finding per comment — the same block
          a reviewer persona posts. The agent marks findings fixed or dismisses
          them with <Code>update</Code> and replies in each finding&apos;s
          thread; you do the same from the review&apos;s page in the drawer, or
          from the finding where it sits in the diff.
        </P>
      </Section>

      <Section>
        <H3>Agent pane: Chat</H3>
        <P>
          The first center tab, <strong>Agent</strong>, is the agent&apos;s
          Chat. Each prompt you send opens a <em>turn</em>: the prompt, a
          folding activity rail of the tool calls the agent made, and the answer
          it ended with. While a turn runs, a <strong>Stop</strong> button next
          to the status line cancels it, and the agent&apos;s current plan shows
          above the composer. The feed also carries the agent&apos;s blocks:
          questions (with option buttons), forms, shared files, links, review
          blocks, task lists, and posts from other agents; each top-level block
          has a thread that opens as a page in the right drawer, over the rail.
          An unread count sits on the Agent tab while another tab is up. Drafts
          survive a reload: text, links and pasted text come back as they were;
          a picked file comes back as a placeholder to re-attach.
        </P>
      </Section>

      <Section>
        <H3>Split pane</H3>
        <P>
          Drag an inactive tab (<strong>Agent</strong> or{" "}
          <strong>Changes</strong>) onto the left or right drop zone to show two
          side by side. A resize handle between the panes lets you adjust the
          ratio. Click the <strong>unsplit</strong> button on the divider to
          return to single-tab view. The split layout persists per agent. Split
          pane is not available on mobile.
        </P>
      </Section>

      <Section>
        <H3 id="prompt-delivery">Prompt delivery</H3>
        <P>
          Automated prompts — a posted review, a diff comment, a post from
          another agent, an answered question, the auto-rename request, browser
          feedback — reach the agent the same way your Chat messages do: each
          one becomes the agent&apos;s next turn. An agent runs one turn at a
          time, so a prompt that arrives mid-turn waits for the running one to
          finish.
        </P>
      </Section>

      <Section>
        <H3 id="quick-phrases">Quick Phrases</H3>
        <P>
          The <strong>Quick Phrases</strong> button (speech-bubble icon) in the
          agent header lets you save reusable text snippets and send them to the
          agent. Phrases are always available for management; sending is enabled
          while an agent is selected.
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
            <strong>Searching</strong> — the popover opens with a search box
            focused; type to filter phrases by label or text. Arrow keys move
            the highlight, and <Code>Enter</Code> sends the highlighted phrase.
            Clicking a phrase row sends it too.
          </li>
          <li>
            <strong>Injecting</strong> — phrases without variables show a split
            button: <strong>Send</strong> posts the text as a Chat message; the
            dropdown offers <strong>Paste without submitting</strong>, which
            puts it in the composer to edit first. Phrases with variables show a{" "}
            <strong>Send…</strong> button that opens the fill-in dialog —
            selecting one via row click or <Code>Enter</Code> opens the same
            dialog.
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
          <Code>rename_session</Code> tool. You can also trigger this manually
          by clicking the <strong>Tag</strong> icon that appears next to a
          running agent that still has a default name. Persona agents and job
          agents are excluded from both paths.
        </P>
        <P>
          To rename any agent yourself, expand its sidebar card and click the
          edit button to open the <strong>Session details</strong> dialog and
          type a new name. The dialog also carries the agent's current status
          and the same branch, worktree, and diff details the card shows — which
          is how you reach them for a sub agent, whose row has no expandable
          details of its own.
        </P>
      </Section>

      <Section>
        <H3>Archiving agents</H3>
        <P>
          Click the archive button to remove an agent. If the agent has a
          worktree with unmerged commits or uncommitted changes, you'll be asked
          whether to keep or remove the worktree. Removing it also deletes the
          branch Dispatch created for the agent — see <strong>Worktrees</strong>{" "}
          for exactly what that throws away. Archived agents are preserved in
          the History section of the Activity page, where you can review their
          events and files.
        </P>
      </Section>

      <Section>
        <H3 id="sub-agents">Agent orchestration</H3>
        <P>
          Agents can launch other agents using the <Code>launch_agent</Code>{" "}
          tool. By default the new agent is a child of the one that launched it:
          it inherits the parent's working directory and full-access mode, and
          renders as a row in the <strong>Sub Agents</strong> list inside the
          parent's expanded card rather than as a card of its own. Persona
          agents appear in the same list, marked with a clipboard icon; a
          reviewer&apos;s review block lands in the parent&apos;s Chat. Passing{" "}
          <Code>child: false</Code> launches an independent agent instead — it
          gets its own top-level card, but Dispatch still records who launched
          it, so the launcher can message and archive it.
        </P>
        <P>
          Nesting stops at one level: a sub agent can only launch independent
          agents, not children or personas of its own. Clicking a sub agent row
          opens its page, the same way a top-level card's row does. An overflow
          menu carries the rest of its session controls: <strong>Pause</strong>/
          <strong>Resume</strong>, <strong>Session details</strong>, and{" "}
          <strong>Archive</strong>. Selecting a sub agent expands the card it
          lives in.
        </P>
        <P>
          Each child is told which agent launched it and can coordinate back
          with <Code>post</Code> and <Code>to</Code> set to the launcher. A
          child has no stream of its own: its posts and its turns live in the
          root agent&apos;s stream, folded under the child&apos;s name, and its
          page shows that stream filtered to the child.
        </P>
        <P>
          Archiving a parent does not archive its launched children — they keep
          running and are promoted to their own top-level cards. This differs
          from persona agents, which are always archived alongside their parent.
          An agent can also retire itself once its work is reported, by calling{" "}
          <Code>archive_agent</Code> with its own ID.
        </P>
      </Section>
    </>
  );
}
