import { Code, H3, P, Section } from "./primitives";

export function EventsContent() {
  return (
    <>
      <P>
        Agents report their status throughout a task using the{" "}
        <Code>dispatch_event</Code> tool. These events drive the status
        indicators in the sidebar and enable Slack notifications.
      </P>

      <Section>
        <H3>Event types</H3>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <Code>working</Code> — actively making progress (reading files,
            writing code, running tests)
          </li>
          <li>
            <Code>blocked</Code> — hit an error or obstacle that needs
            resolution
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
          timestamp (e.g. "just now", "5m ago"), and the message. Events are
          also stored in the database for activity tracking — the Activity page
          uses them to build heatmaps, working-time breakdowns, and daily status
          charts.
        </P>
      </Section>

      <Section>
        <H3>Configuring agent instructions</H3>
        <P>
          To get agents to report events, add instructions to your repo's{" "}
          <Code>CLAUDE.md</Code> (or equivalent config) telling the agent to
          call <Code>dispatch_event</Code> at key checkpoints: start of turn,
          phase transitions, errors, and before the final response.
        </P>
      </Section>
    </>
  );
}
