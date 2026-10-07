import { Code, H3, P, Section } from "./primitives";

export function UpdatesContent() {
  return (
    <>
      <P>
        Open <strong>Settings → Updates</strong> to see the deployed release
        tag, switch release channels, pull a new release, or reload the web app.
        On the Mac app, updates come from the menu bar app instead; this page
        only explains how.
      </P>

      <Section>
        <H3>Current version</H3>
        <P>
          The top of the pane shows the deployed release tag and when it was
          deployed, with a detail card below showing the package version and git
          SHA. Release notes are in a separate collapsible section — click the
          header to expand. If the release is on GitHub, a link next to the
          header opens it in a new tab.
        </P>
      </Section>

      <Section>
        <H3>Release channel</H3>
        <P>
          Pick <strong>stable</strong> to follow promoted releases or{" "}
          <strong>preview</strong> to get every release as soon as it ships. The
          installer sets the starting channel; switching here resets the
          update-check state so the next check uses the new feed.
        </P>
      </Section>

      <Section>
        <H3>Checking for updates</H3>
        <P>
          Dispatch checks for updates automatically in the background (every six
          hours while the server is running). When a newer tag is discovered, a
          toast notification appears with an <strong>Update now</strong> button.
          Dismissing the toast suppresses it until a different release is
          available. You can also click <strong>Check for updates</strong> on
          the Updates page to force a manual check. If you're up to date, you'll
          see a green check.
        </P>
        <P>
          Automatic checks can be turned off via the{" "}
          <strong>Automatic updates</strong> dropdown on the Updates page.
          Updates never install automatically — the toast only notifies.
        </P>
      </Section>

      <Section>
        <H3>One-click update</H3>
        <P>
          <strong>Update to vX.Y.Z</strong> kicks off a server-side flow (fetch
          → deploy → restart) that takes over the Updates pane with phase
          progress and a streaming log. After the restart the page polls until
          the new tag responds; once it's live, click <strong>Done</strong> to
          dismiss.
        </P>
        <P>
          On Linux the update refuses to start unless the{" "}
          <Code>dispatch.service</Code> unit has <Code>KillMode=process</Code>,
          so running agents survive the restart. The installer writes that
          setting for you.
        </P>
      </Section>

      <Section>
        <H3>Reload</H3>
        <P>
          <strong>Reload</strong> unregisters the service worker and reloads so
          the next page load picks up the latest build directly. The dropdown
          offers <strong>Clear cache &amp; reload</strong>, which also clears
          all Cache Storage API entries before reloading — useful if the app
          feels stuck on a stale build.
        </P>
      </Section>
    </>
  );
}
