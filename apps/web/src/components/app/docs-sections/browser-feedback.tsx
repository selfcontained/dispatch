import { Code, H3, P, Section } from "./primitives";

export function BrowserFeedbackContent() {
  return (
    <>
      <P>
        The Dispatch Browser Feedback extension lets you select an element on
        any web page, add a comment, and send it — along with bounded DOM
        context for that element — straight to a running agent. It's a Chrome
        extension you pair with your Dispatch instance under{" "}
        <strong>Settings → Connections</strong>.
      </P>

      <Section>
        <H3>Installing the extension</H3>
        <P>
          The extension is a developer preview, so Chrome loads it from an
          unzipped folder. In <strong>Settings → Connections</strong>, download
          the extension ZIP and unzip it somewhere Chrome can keep reading. Open{" "}
          <Code>chrome://extensions</Code>, enable{" "}
          <strong>Developer mode</strong>, choose <strong>Load unpacked</strong>
          , and select the extracted folder. Click the extension's toolbar icon
          to open its side panel.
        </P>
      </Section>

      <Section>
        <H3>Pairing a browser</H3>
        <P>
          In the side panel, enter your <strong>Dispatch URL</strong> and start
          the connection. Dispatch opens an approval prompt showing a six-digit
          code; confirm it matches the code in the extension and approve. Once
          the browser finishes connecting it appears under{" "}
          <strong>Paired browsers</strong> in Settings. Each Chrome profile gets
          its own revocable, 90-day token stored only in extension-local storage
          — so pairing a new profile or machine is a separate request.
        </P>
      </Section>

      <Section>
        <H3>Sending feedback</H3>
        <P>
          Open the side panel on the page you want to inspect and start element
          selection — hover to highlight, click to select, or press{" "}
          <Code>Escape</Code> to cancel. The panel previews the sanitized
          context that will be shared. Add a <strong>Comment</strong>, pick one
          of your <strong>running agents</strong>, and choose{" "}
          <strong>Send to agent</strong>. The comment and page context are
          delivered to that agent as a prompt. Only running agents are
          selectable; use <strong>Refresh running agents</strong> if the list is
          stale.
        </P>
      </Section>

      <Section>
        <H3>Privacy and page access</H3>
        <P>
          The inspected page never has to share an origin with Dispatch. On
          first use Chrome asks you to grant the extension access to HTTP and
          HTTPS pages; this optional grant keeps the picker reliable as you move
          between projects and can be revoked from Chrome at any time.
          Browser-owned pages such as <Code>chrome://</Code> and the Chrome Web
          Store can't be inspected.
        </P>
        <P>
          Before previewing or sending, the extension strips form values,
          editable content, scripts, inline event handlers, <Code>srcdoc</Code>,
          and likely-secret URL parameters. The agent receives the page context
          marked as untrusted observational data, not as instructions. HTTP
          Dispatch URLs are supported for self-hosted setups but require an
          explicit acknowledgement that HTTP sends without transport encryption.
        </P>
      </Section>

      <Section>
        <H3>Managing connections</H3>
        <P>
          <strong>Settings → Connections</strong> lists every paired browser
          with its device name and when it was last used. Each browser has its
          own access — revoke one with <strong>Revoke</strong> and the others
          stay connected. You can also <strong>Disconnect</strong> from the
          extension itself, which removes the local token and the optional
          Dispatch host permission.
        </P>
      </Section>
    </>
  );
}
