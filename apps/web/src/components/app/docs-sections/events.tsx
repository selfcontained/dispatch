import { Code, H3, P, Section } from "./primitives";

export function EventsContent() {
  return (
    <>
      <P>
        Agents report their status throughout a task using the{" "}
        <Code>dispatch_event</Code> tool. These events drive the status
        indicators in the sidebar, and <Code>done</Code>,{" "}
        <Code>waiting_user</Code>, and <Code>blocked</Code> also trigger browser
        and Slack notifications.
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
      </Section>

      <Section>
        <H3>Automatic status correction</H3>
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

      <Section>
        <H3>Configuring agent instructions</H3>
        <P>
          Dispatch already injects startup rules at launch telling the agent
          which event types to use and when to emit them, so reporting works
          without any setup. To reinforce or customize the behavior, add
          instructions to your repo's <Code>CLAUDE.md</Code> (or equivalent
          config) covering the checkpoints that matter to you: start of turn,
          phase transitions, and a terminal event before the final response.
        </P>
      </Section>
    </>
  );
}
