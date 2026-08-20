import { Code, H3, P, Section } from "./primitives";

export function NotificationsContent() {
  return (
    <>
      <P>
        Dispatch can notify you when agents finish, need input, or get stuck —
        so you don't have to watch the dashboard. Notifications are delivered
        through three channels: native browser notifications, Slack, and local
        sound cues. All three are configured in{" "}
        <strong>Settings → Notifications</strong>.
      </P>

      <Section>
        <H3>Configurable events</H3>
        <P>
          For browser and Slack notifications, you choose which agent status
          changes trigger a notification:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <Code>done</Code> — agent finished its task
          </li>
          <li>
            <Code>waiting_user</Code> — agent needs your input
          </li>
          <li>
            <Code>blocked</Code> — agent is stuck with no further approach to
            try
          </li>
        </ul>
      </Section>

      <Section>
        <H3>Browser notifications</H3>
        <P>
          Grant the browser permission, then toggle{" "}
          <strong>Enable browser notifications</strong> — the toggle stays
          disabled until permission is granted. When the app is open in at least
          one tab, matching events are delivered as native desktop or mobile
          banners instead of Slack. If no tab acknowledges the notification
          within about three seconds, Dispatch falls back to Slack
          automatically. <strong>Send test</strong> fires a sample banner so you
          can confirm the setup.
        </P>
        <P>
          On iOS and iPadOS, notifications only work after installing Dispatch
          as a PWA via <em>Add to Home Screen</em>.
        </P>
      </Section>

      <Section>
        <H3>Slack</H3>
        <P>
          Paste a{" "}
          <a
            href="https://api.slack.com/messaging/webhooks"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline"
          >
            Slack incoming webhook
          </a>{" "}
          URL and use <strong>Send Slack test</strong> to verify it, then click{" "}
          <strong>Save</strong> — the webhook and the Slack event list are only
          persisted when you save, unlike the browser toggles above, which save
          as soon as you flip them. Configured events fire to Slack whenever a
          browser notification isn't delivered (no tab open, permission denied,
          or the event isn't in your browser-notification list). Agents launched
          by a job are the exception: their status events go to browser
          notifications only, never to Slack.
        </P>
      </Section>

      <Section>
        <H3>Sound cues</H3>
        <P>
          A soft synthesized tone on status changes. Cues are per-device — they
          don't touch server state and only play in tabs where you've enabled
          them. Four status cues are available: <Code>done</Code>,{" "}
          <Code>waiting_user</Code>, <Code>blocked</Code>, and a distinct chord
          when a persona reviewer completes its review. A fifth cue provides
          tactile feedback for mobile toolbar taps. Use the preview buttons in
          settings to hear each one.
        </P>
      </Section>

      <Section>
        <H3>Tips &amp; guidance</H3>
        <P>
          The same settings pane hosts <strong>Tips &amp; Guidance</strong> —
          short contextual hints that point out features and link into these
          docs. They're per-device like sound cues. Untick{" "}
          <strong>Show tips</strong> to turn them off, or use{" "}
          <strong>Reset dismissed tips</strong> to bring back everything you've
          already dismissed.
        </P>
      </Section>

      <Section>
        <H3 id="focus-suppression">Focus-aware suppression</H3>
        <P>
          Dispatch suppresses browser and Slack notifications for an agent
          you're already looking at. Tabs that have an agent selected send a
          focus heartbeat every 15 seconds while the tab is visible and focused,
          and notifications for that agent are dropped while it's live. Blurring
          the window, hiding the tab, or switching agents clears focus
          immediately, so notifications resume right away; the heartbeat also
          expires on its own after 30 seconds if a tab goes away without
          reporting. Sound cues are not filtered by focus.
        </P>
      </Section>

      <Section>
        <H3>Agent-initiated notifications</H3>
        <P>
          Agents can push a Slack message mid-task by calling the{" "}
          <Code>dispatch_notify</Code> MCP tool — useful for summarizing
          intermediate results, flagging risks, or asking you to check something
          specific. Parameters:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <Code>message</Code> — body with Slack mrkdwn (max 3000 chars).
          </li>
          <li>
            <Code>title</Code> — optional title (max 150 chars). Defaults to{" "}
            <em>Notification from &lt;agent&gt;</em>.
          </li>
          <li>
            <Code>level</Code> — <Code>info</Code>, <Code>success</Code>,{" "}
            <Code>warning</Code>, or <Code>error</Code>; controls the attachment
            color and emoji.
          </li>
          <li>
            <Code>respectFocus</Code> — when <Code>true</Code>, the notification
            is suppressed while you're actively viewing the agent. Defaults to{" "}
            <Code>false</Code>.
          </li>
        </ul>
        <P>
          Rate limited to 5 notifications per minute per agent. Requires a Slack
          webhook. Available to regular and job agents; persona agents don't
          have this tool.
        </P>
      </Section>
    </>
  );
}
