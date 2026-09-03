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
            <strong>Model</strong> — shown for CLI types with a curated model
            catalog (<Code>claude</Code>, <Code>codex</Code>). Pin the agent to
            a specific model, or leave <strong>Default</strong> to use the CLI's
            own setting. The choice sticks with the agent and is reused when it
            resumes.
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
            the agent automatically launches one reviewer agent on completion
            and addresses its feedback before finishing.
          </li>
        </ul>
        <P>
          The form reopens with the choices you last made in that working
          directory: full access, Autonomous Review, the starting branch, and
          the new-branch checkbox are remembered per directory, and the model
          per directory and agent type.
        </P>
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
          session later. Click an agent card to attach your terminal to its
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
          uncommitted changes against the base branch. The details card also has
          a button to open the working directory in your IDE and, for worktree
          agents, a pill that copies the worktree path. CLI agents additionally
          show whether they're running in full access or sandboxed mode, plus a{" "}
          <strong>Review</strong> button that launches one or more reviewer
          agents (see the Reviewers section — review feedback lives in the
          Changes tab's threads, not on the card); terminal agents skip those
          since they have no CLI. Agents launched as children — persona
          reviewers included — appear in a <strong>Sub Agents</strong> list in
          the expanded card.
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
          the pane to split the workspace. Split panes let you keep the terminal
          and diff visible together, resize them with the center handle, and
          return to a single pane with the unsplit control.
        </P>
        <P>
          Select one or more lines in a diff, then click the comment icon to
          leave feedback. The primary action is <strong>Start a review</strong>,
          which enters review mode and saves the comment as a draft. Use the
          dropdown to pick <strong>Chat</strong> instead — that sends the
          comment directly to the agent's terminal as a one-off message (the
          original behavior).
        </P>
        <P>
          In review mode, a bar at the top shows your draft count and a{" "}
          <strong>Submit review</strong> button. Keep adding draft comments
          across different files, then submit them all at once with an optional
          summary. Each comment becomes a feedback item the agent can see via
          its <Code>dispatch_review_list_feedback</Code> tool.
        </P>
        <P>
          Feedback threads are interactive from both sides. The agent can reply,
          resolve items as <strong>fixed</strong> or <strong>dismissed</strong>,
          or ask clarifying questions via MCP tools. You can do the same from
          the UI — reply to a thread, mark an item resolved, or reopen it —
          either inline in the diff or from the <strong>Reviews</strong> tab of
          the media sidebar.
        </P>
      </Section>

      <Section>
        <H3 id="whiteboard">Whiteboard</H3>
        <P>
          The <strong>Whiteboard</strong> tab in the center pane is a shared
          Excalidraw canvas, one per agent. Sketch an architecture, flow, or
          idea and ask the agent to &ldquo;look at the whiteboard&rdquo; — or
          ask it to draw something for you. Edits sync live in both directions:
          your changes save automatically as you draw, and if both sides edit at
          once the scenes are merged element by element. The board persists with
          the agent, so it survives detaching, stopping, and resuming.
        </P>
        <P>
          Agents work the board through four MCP tools:{" "}
          <Code>whiteboard_get</Code> returns the element list plus the path to
          a PNG snapshot of the board the agent can open to actually see the
          drawing, <Code>whiteboard_howto</Code> hands the agent the Excalidraw
          element format and layout conventions on demand,{" "}
          <Code>whiteboard_update</Code> adds or replaces elements by id (and
          removes them by id), and <Code>whiteboard_clear</Code> wipes the
          board. The snapshot is rendered by your browser shortly after edits
          settle, so a board that has never been opened in the UI has no image
          yet — the agent falls back to the element list.
        </P>
        <P>
          When the agent draws while you're on another tab, a violet dot appears
          on the <strong>Whiteboard</strong> tab until you open it.
        </P>
      </Section>

      <Section>
        <H3>Chat tab (beta)</H3>
        <P>
          Turn on <strong>Chat surface</strong> under Settings → Agents to put a{" "}
          <strong>Chat</strong> tab in front of each agent's terminal. The
          agent's replies, questions, status updates, shared files, and messages
          from other agents appear there as a feed; what you type is delivered
          into the agent's terminal, and the terminal itself stays one click
          away as the <strong>Console</strong> tab. Agents reply through the{" "}
          <Code>dispatch_chat_post</Code> tool, so an agent that only prints in
          its terminal has nothing in the Chat tab — open the Console to see it.
          Questions come with option buttons; picking one sends that answer
          back. An unread count on the tab tracks replies you haven't seen. With
          the setting off nothing changes.
        </P>
      </Section>

      <Section>
        <H3>Split pane</H3>
        <P>
          Drag an inactive tab (<strong>Terminal</strong>,{" "}
          <strong>Changes</strong>, or <strong>Whiteboard</strong>) onto the
          left or right drop zone to show two side by side. A resize handle
          between the panes lets you adjust the ratio. Click the{" "}
          <strong>unsplit</strong> button on the divider to return to single-tab
          view. The split layout persists per agent. Split pane is not available
          on mobile.
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
        <H3 id="prompt-delivery">Prompt delivery</H3>
        <P>
          Dispatch types automated prompts — review feedback and diff comments,
          agent-to-agent messages, the auto-rename request, browser feedback —
          straight into the agent's terminal, the same input you type into. Turn
          on <strong>Hold automated prompts while you type</strong> in{" "}
          <strong>Settings → Agents</strong> to stop them landing mid-sentence.
          It's off by default, and the setting applies to every agent on the
          server.
        </P>
        <P>
          With it on, an automated prompt waits for a 10-second pause in your
          terminal activity (keystrokes, clicks, and scrolls all reset the
          timer) before it's delivered. While one is waiting, a blue envelope
          badge appears in the bottom-right of the terminal; its ring fills as
          the pause elapses, and a count appears when more than one prompt is
          queued. Hover it for an explanation and click to send immediately — on
          touch devices, tap it for a <strong>Send now</strong> button. Sending
          now releases everything queued for that agent. Nothing waits forever:
          after 60 seconds a prompt is delivered even if you're still typing.
        </P>
        <P>
          Things you send yourself — quick phrases, shortcut pins, dropped or
          pasted files — never wait; they're meant to land where your cursor is.
          They still take their turn behind a prompt that is actively being
          typed in, so the two can't interleave.
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
            <strong>Searching</strong> — the popover opens with a search box
            focused; type to filter phrases by label or text. Arrow keys move
            the highlight, and <Code>Enter</Code> sends the highlighted phrase.
            Clicking a phrase row sends it too.
          </li>
          <li>
            <strong>Injecting</strong> — phrases without variables show a split
            button: <strong>Send</strong> pastes the text and submits it; the
            dropdown offers <strong>Paste without submitting</strong> which
            pastes only. Phrases with variables show a <strong>Send…</strong>{" "}
            button that opens the fill-in dialog — selecting one via row click
            or <Code>Enter</Code> opens the same dialog.
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
          events, media, pins, feedback, and messages.
        </P>
      </Section>

      <Section>
        <H3 id="sub-agents">Agent orchestration</H3>
        <P>
          Agents can launch other agents using the{" "}
          <Code>dispatch_launch_agent</Code> tool. By default the new agent is a
          child of the one that launched it: it inherits the parent's working
          directory and full-access mode, and renders as a row in the{" "}
          <strong>Sub Agents</strong> list inside the parent's expanded card
          rather than as a card of its own. Persona reviewers appear in the same
          list, marked with a clipboard icon that turns into a green checkmark
          once its review is submitted — click it to open the review directly.
          Passing <Code>child: false</Code> launches an independent agent
          instead — it gets its own top-level card, but Dispatch still records
          who launched it, so the launcher can message and archive it.
        </P>
        <P>
          Nesting stops at one level: a sub agent can only launch independent
          agents, not children or persona reviews of its own. Clicking a sub
          agent row's own body connects or disconnects its terminal, the same
          way a top-level card's row does. An overflow menu carries the rest of
          its session controls: <strong>View terminal</strong>/
          <strong>Detach</strong>, <strong>Open review</strong> (once a review
          is submitted), <strong>Pause</strong>/<strong>Resume</strong>,{" "}
          <strong>Session details</strong>, and <strong>Archive</strong>.
          Selecting a sub agent expands the card it lives in.
        </P>
        <P>
          Each child is told which agent launched it and can coordinate back
          using <Code>dispatch_send_message</Code>. Messages are persisted and
          visible in the <strong>Messages</strong> tab of the media sidebar,
          grouped by conversation partner.
        </P>
        <P>
          Archiving a parent does not archive its launched children — they keep
          running and are promoted to their own top-level cards. This differs
          from persona reviewers, which are always archived alongside their
          parent. An agent can also retire itself once its work is reported, by
          calling <Code>dispatch_archive_agent</Code> with its own ID.
        </P>
      </Section>
    </>
  );
}
