import { Code, H3, P, Section } from "./primitives";

export function UpdatesContent() {
  return (
    <>
      <P>
        Open <strong>Settings → Updates</strong> to see the deployed release
        tag, switch release channels, pull a new release, or reload the web app.
        Most upgrades are one click; releases that touch infrastructure (runtime
        swaps, schema migrations) gate that one-click path behind an
        assisted-update agent that drives the upgrade and recovers service if
        anything goes sideways.
      </P>

      <Section>
        <H3>Current version</H3>
        <P>
          The top of the pane shows the deployed release tag and when it was
          deployed, plus an expandable card with the package version, git SHA,
          and release notes. If the release page is on GitHub, a link opens it
          in a new tab.
        </P>
      </Section>

      <Section>
        <H3>Release channel</H3>
        <P>
          Pick <strong>stable</strong> to follow tagged releases or{" "}
          <strong>latest</strong> to follow the most recent published release
          (including pre-releases). Switching channels resets the update-check
          state so the next check uses the new feed.
        </P>
      </Section>

      <Section>
        <H3>Checking for updates</H3>
        <P>
          Dispatch checks for updates automatically in the background (every six
          hours while the server is running). When a newer tag is discovered, a
          toast notification appears with an action button — either{" "}
          <strong>Update now</strong> (for simple releases) or{" "}
          <strong>Review update</strong> (when guided steps are needed).
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
          Releases that ship pending migrations or declare <Code>mode</Code> ={" "}
          <Code>required</Code> gate this path: the server returns a 409 with{" "}
          <Code>ASSISTED_UPDATE_REQUIRED</Code>, and the agent-assisted button
          moves into the primary slot of the split control. You can still
          override from the dropdown — the standard menu item becomes{" "}
          <strong>Update to vX.Y.Z…</strong> and opens a confirmation dialog
          that posts <Code>force: true</Code>. Use only when you understand what
          the gate was protecting.
        </P>
      </Section>

      <Section>
        <H3>Agent-assisted update</H3>
        <P>
          <strong>Agent-assisted update</strong> launches a full-access CLI
          agent on the production checkout and redirects you into its terminal.
          The agent runs as the special <Code>assisted_update</Code> role (its
          sidebar card carries a blue <strong>Update</strong> badge), holds a
          one-time token that lets it call the update endpoint
          non-interactively, and is instructed to restore service first if the
          restart goes wrong. Only one assisted-update agent can be active at a
          time.
        </P>
        <P>
          Three independent signals can promote this path to primary, and any
          one of them is enough:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <strong>Pending migrations.</strong> A release can ship one or more{" "}
            <Code>update-migrations/*.yaml</Code> manifests describing complex
            install-side steps. <Code>/release/info</Code> evaluates them
            against this install's <Code>applied-migrations.json</Code>; any
            that haven't run yet appear in the response as{" "}
            <Code>pendingMigrations</Code> and render as a stacked gate card
            listing each step's id, title, and summary.
          </li>
          <li>
            <strong>Release-body metadata.</strong> The release notes can carry
            a <Code>dispatch-update</Code> JSON block declaring a{" "}
            <Code>mode</Code> (<Code>normal</Code>, <Code>recommended</Code>, or{" "}
            <Code>required</Code>), a title and summary, optional instructions
            and rollback guidance, and a list of <Code>requiredChecks</Code>. An
            optional <Code>appliesFrom</Code> semver narrows{" "}
            <Code>required</Code> to installs at or above that version.
          </li>
          <li>
            <strong>Evaluator failure.</strong> If the server can't evaluate the
            migration manifests (network blip, malformed YAML),{" "}
            <Code>/release/info</Code> returns <Code>migrationsError</Code> and
            the UI surfaces an amber warning. Standard update stays available,
            but assisted is the safer choice.
          </li>
        </ul>
        <P>
          The action lives in a single split button whose primary slot flips
          based on what the server reports:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <strong>normal / no metadata + no migrations</strong> — primary is{" "}
            <strong>Update to vX.Y.Z</strong>, with{" "}
            <strong>Agent-assisted update</strong> in the dropdown. Releases
            without a metadata block fall back to a legacy recovery skeleton
            prompt.
          </li>
          <li>
            <strong>recommended</strong> — the metadata gate card is shown.
            Primary flips to <strong>Agent-assisted update</strong>;{" "}
            <strong>Update to vX.Y.Z</strong> stays one click away in the
            dropdown with no confirmation.
          </li>
          <li>
            <strong>required / pending migrations</strong> — gate cards are
            shown and primary stays on <strong>Agent-assisted update</strong>.
            The standard menu item becomes <strong>Update to vX.Y.Z…</strong>{" "}
            and routes through the force-override dialog.
          </li>
        </ul>
        <P>
          Once an assisted run is in flight, the takeover view tracks phases the
          agent reports back: <Code>inspect</Code> → <Code>prepare</Code> →{" "}
          <Code>apply</Code> → <Code>restarting</Code> → <Code>validate</Code> →{" "}
          <Code>done</Code>. Per-phase notes from the agent and the structured
          results of each required check (re-run server-side after{" "}
          <Code>validate</Code>) appear in the left column. Terminal failure
          states: <Code>blocked</Code> (a required check failed),{" "}
          <Code>rollback</Code> (the agent reverted to a healthy tag), and{" "}
          <Code>failed</Code> (the run aborted before reaching <Code>done</Code>
          ).
        </P>
      </Section>

      <Section>
        <H3>Reload</H3>
        <P>
          <strong>Reload</strong> picks up the latest web bundle by forcing the
          service worker to take control on the next load. The dropdown offers{" "}
          <strong>Clear cache &amp; reload</strong>, which unregisters all
          service workers and clears the Cache Storage API entries first —
          useful if the app feels stuck on a stale build.
        </P>
      </Section>
    </>
  );
}
