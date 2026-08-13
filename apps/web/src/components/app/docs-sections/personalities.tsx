import { Code, H3, P, Section } from "./primitives";

export function PersonalitiesContent() {
  return (
    <>
      <P>
        A personality is a short block of text that Dispatch appends to every
        regular agent's system prompt at launch. Use it for voice (
        <em>"keep replies brief and sardonic"</em>) or standing preferences (
        <em>"prefer pnpm over npm; never run dev servers in the foreground"</em>
        ). Personalities are unrelated to <strong>Reviewers</strong> — those are
        full prompt definitions for one-off review agents and are managed
        separately.
      </P>

      <Section>
        <H3>Managing personalities</H3>
        <P>
          Open <strong>Settings → Agents</strong>. The Personalities list is at
          the top of the pane. Click <strong>New personality</strong> to add
          one. Each entry has:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <strong>Name</strong> — up to 80 characters, must be unique. Shown
            in the row and on the active toggle.
          </li>
          <li>
            <strong>Prompt</strong> — up to 1000 characters. This is the text
            appended verbatim to the agent's system prompt at launch.
          </li>
        </ul>
        <P>
          Existing entries expose <strong>Edit</strong> and{" "}
          <strong>Delete</strong> actions inline. A running agent keeps the
          prompt it was launched with — edits are picked up the next time an
          agent launches, or when a paused agent resumes.
        </P>
        <P>
          Agents can manage personalities too: standard agents get{" "}
          <Code>list_personalities</Code>, <Code>create_personality</Code>,{" "}
          <Code>update_personality</Code>, <Code>delete_personality</Code>,{" "}
          <Code>set_active_personality</Code>, and{" "}
          <Code>clear_active_personality</Code> MCP tools, so you can ask an
          agent to draft, tweak, or switch the active personality for you.
        </P>
      </Section>

      <Section>
        <H3>Activating</H3>
        <P>
          Click the radio circle on the left of a row to make a personality
          active; click it again to deactivate. Only one personality can be
          active at a time, and the active one applies to <em>every</em> regular
          agent you create from then on. There is no per-agent override — if no
          personality is active, agents launch with no personality text
          appended.
        </P>
      </Section>

      <Section>
        <H3>What it applies to</H3>
        <P>
          The active personality is looked up fresh each time a standard agent
          launches or resumes: it goes into Claude's{" "}
          <Code>--append-system-prompt</Code> flag and into the launch prompt
          for Codex, Cursor, and OpenCode — including on resume, where it's
          re-sent as the trailing prompt (<Code>codex resume</Code> accepts an
          optional prompt after the session id, and Cursor/OpenCode always
          resend theirs too). Terminal agents have no CLI to inject into, so the
          personality is silently skipped.
        </P>
        <P>
          Three flows intentionally <em>don't</em> get the personality, since
          they ship their own carefully-tuned prompts and an extra voice tweak
          risks destabilizing them:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <strong>Persona reviewers</strong> launched via{" "}
            <Code>dispatch_launch_persona</Code> or the Reviewers UI.
          </li>
          <li>
            <strong>Job runs</strong> spawned by the scheduler or a manual{" "}
            <strong>Run now</strong>.
          </li>
          <li>
            <strong>Agent-assisted update</strong> agents created from the
            Updates pane.
          </li>
        </ul>
      </Section>
    </>
  );
}
