import { Code, H3, P, Section } from "./primitives";

export function EventsContent() {
  return (
    <>
      <P>
        Dispatch derives each agent's status from its live stream; agents do not
        report it themselves. Status drives the indicators in the sidebar, and{" "}
        <Code>waiting_user</Code> and <Code>blocked</Code> also trigger browser
        and Slack notifications.
      </P>

      <Section>
        <H3>How status is derived</H3>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <Code>working</Code> — a turn is open: the agent is answering a
            message, running tools, or thinking. The message is the first line
            of the prompt that opened the turn.
          </li>
          <li>
            <Code>waiting_user</Code> — the agent asked a question in Chat that
            nobody has answered yet. Set the moment the question lands, and kept
            when the turn closes with it still open.
          </li>
          <li>
            <Code>idle</Code> — the last turn closed with nothing pending.
          </li>
          <li>
            <Code>blocked</Code> — the last turn ended in an error, the engine
            exited on its own, or setup failed. The message carries the error.
          </li>
        </ul>
        <P>
          Dispatch also writes lifecycle marks: one per setup phase while the
          workspace and engine come up (shown as the Setup block at the top of
          the stream), session started, stopped, and resumed.
        </P>
      </Section>

      <Section>
        <H3>How events are used</H3>
        <P>
          Each agent's card in the sidebar shows the latest status label
          (Working / Blocked / Waiting / Idle, color-coded), a relative
          timestamp (e.g. "just now", "5m ago"), and the repo name. Expanding
          the card adds the message below that line. Events are also stored in
          the database for activity tracking — the Activity page uses them to
          build the activity and active-hours heatmaps, working-time stats, and
          the status breakdown chart.
        </P>
        <P>
          Sub agent rows and the <strong>Session details</strong> dialog show
          the agent's current state instead of a stale event: an agent that has
          stopped reads <strong>Stopped</strong> (or <strong>Error</strong> if
          it failed), whatever its last status was.
        </P>
      </Section>
    </>
  );
}
