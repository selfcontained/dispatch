import { Code, H3, P, Section } from "./primitives";

export function EventsContent() {
  return (
    <>
      <P>
        Dispatch derives each agent's status from its live stream; agents do not
        report it themselves. Status drives the indicators in the sidebar, and{" "}
        <Code>done</Code>, <Code>waiting_user</Code>, and <Code>blocked</Code>{" "}
        also trigger browser and Slack notifications.
      </P>

      <Section>
        <H3>Event types</H3>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <Code>working</Code> — actively making progress (reading files,
            writing code, running tests)
          </li>
          <li>
            <Code>blocked</Code> — completely stuck with no further approach to
            try (not for errors or test failures the agent plans to fix next —
            those stay <Code>working</Code>)
          </li>
          <li>
            <Code>waiting_user</Code> — needs a decision or approval before
            continuing
          </li>
          <li>
            <Code>done</Code> — task is complete
          </li>
          <li>
            <Code>idle</Code> — no meaningful action was taken (e.g. answered an
            informational question)
          </li>
        </ul>
      </Section>

      <Section>
        <H3>How events are used</H3>
        <P>
          Each agent's card in the sidebar shows the latest event's status label
          (Working / Blocked / Waiting / Done / Idle, color-coded), a relative
          timestamp (e.g. "just now", "5m ago"), and the repo name. Expanding
          the card adds the event message below that line. Events are also
          stored in the database for activity tracking — the Activity page uses
          them to build the activity and active-hours heatmaps, working-time
          stats, and the status breakdown chart.
        </P>
        <P>
          Sub agent rows and the <strong>Session details</strong> dialog show
          the agent's current state instead of a stale event: an agent that has
          stopped reads <strong>Stopped</strong> (or <strong>Error</strong> if
          it failed), whatever its last reported event was, and one that hasn't
          reported yet reads <strong>Running</strong>. The timestamp next to it
          is still the last event's.
        </P>
      </Section>

      <Section>
        <H3 id="status-correction">Automatic status correction</H3>
        <P>
          Agents don't always report accurately, so Dispatch cross-checks each
          running agent's status against its terminal activity. If the terminal
          is producing output but the status isn't <Code>working</Code>, it's
          corrected to <Code>working</Code> with the message "Activity
          detected". If the status is <Code>working</Code> but the terminal has
          been silent for three minutes, it's corrected to <Code>idle</Code>{" "}
          with "No recent activity detected". A correction is skipped if the
          agent reported a new event in the meantime, so a live agent always
          wins over the check.
        </P>
      </Section>
    </>
  );
}
