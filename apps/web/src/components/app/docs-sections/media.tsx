import { Code, H3, P, Section } from "./primitives";

export function MediaContent() {
  return (
    <>
      <P>
        Agents can capture and share screenshots, images, and text files during
        a session. Shared media appears in the Media sidebar for review.
      </P>

      <Section>
        <H3>Sharing files</H3>
        <P>
          Agents call the <Code>dispatch_share</Code> tool with a{" "}
          <Code>filePath</Code> and a <Code>description</Code> to publish an
          existing file. Supported formats are PNG, JPG, GIF, WebP, MP4, PDF,
          and a wide range of text file extensions (txt, md, html, json, yaml,
          ts, py, go, rs, sh, sql, and many others).
        </P>
      </Section>

      <Section>
        <H3>Sharing text snippets</H3>
        <P>
          Instead of writing a scratch file first, agents can pass the text
          directly as <Code>content</Code> along with a <Code>name</Code> that
          has an appropriate extension (e.g. <Code>snippet.ts</Code>). Content
          is capped at 32KB — for anything larger, write the file and use{" "}
          <Code>filePath</Code>.
        </P>
      </Section>

      <Section>
        <H3>Updating shared media</H3>
        <P>
          Every <Code>dispatch_share</Code> call returns a <Code>fileName</Code>
          . Pass that back as the <Code>update</Code> parameter on a later call
          to replace the existing file in place instead of creating a new entry
          — useful for iterating on a screenshot or snippet without cluttering
          the sidebar.
        </P>
      </Section>

      <Section>
        <H3>Simulator screenshots</H3>
        <P>
          When <Code>dispatch_share</Code> is called with{" "}
          <Code>source: "simulator"</Code>, it captures a screenshot from the
          iOS Simulator using <Code>xcrun simctl</Code> and shares the resulting
          PNG. <Code>simulatorUdid</Code> selects a specific simulator; it
          defaults to the booted one.
        </P>
      </Section>

      <Section>
        <H3>Screen streaming</H3>
        <P>
          Agents running Playwright can stream their browser session live. The
          stream appears in the media sidebar as a real-time MJPEG feed via
          Chrome DevTools Protocol. When the stream ends, the last frame is
          saved as a screenshot.
        </P>
      </Section>

      <Section>
        <H3>Listing shared media</H3>
        <P>
          Agents can call <Code>dispatch_list_media</Code> to enumerate the
          files they (or the user) have shared in the current session. An
          optional <Code>source</Code> filter narrows the results — e.g.{" "}
          <Code>"user"</Code>, <Code>"screenshot"</Code>, <Code>"text"</Code>,{" "}
          <Code>"simulator"</Code>, or <Code>"stream"</Code>.
        </P>
        <P>
          To remove an item that is no longer relevant, call{" "}
          <Code>dispatch_delete_media</Code> with its exact{" "}
          <Code>fileName</Code> from the listing. This permanently removes the
          file and its media entry.
        </P>
      </Section>

      <Section>
        <H3 id="uploading-files">Uploading files to agents</H3>
        <P>
          You can send files directly to a running agent by{" "}
          <strong>dragging and dropping</strong> them onto the terminal or by{" "}
          <strong>pasting an image</strong> from your clipboard (
          <Code>Cmd+V</Code> / <Code>Ctrl+V</Code>). Uploaded files are saved to
          the agent's media store and automatically injected into the agent's
          prompt — images go through the native clipboard when available, and
          all other files are typed into tmux as{" "}
          <Code>[File&nbsp;#N]&nbsp;/path/to/file</Code>.
        </P>
        <P>
          You can also upload files via the <strong>Share file</strong> button
          in the media sidebar. Sidebar uploads are <em>not</em> injected into
          the terminal — tell the agent about the file afterward so it knows to
          look.
        </P>
      </Section>

      <Section>
        <H3>Lightbox previews</H3>
        <P>
          Clicking a media item opens a full-screen lightbox that renders each
          file by type: images zoom and pan, videos play inline, PDFs embed,
          markdown renders formatted, and other text files display with syntax
          highlighting. Shared <Code>.html</Code> files render as a live page
          preview in a sandboxed frame — scripts run, but the page is isolated
          from Dispatch itself — with an <strong>Open in tab</strong> action to
          view it full-size. For markdown and HTML, the copy button copies the
          source.
        </P>
      </Section>

      <Section>
        <H3 id="media-sidebar">Media sidebar</H3>
        <P>
          Click the media sidebar button at the right of the terminal's top bar
          (or press <Code>Mod+Shift+&gt;</Code>) to open the sidebar. The button
          shows a count badge when there are unseen media items or unread
          messages. The sidebar has four tabs: <strong>Pins</strong>,{" "}
          <strong>Media</strong>, <strong>Reviews</strong>, and{" "}
          <strong>Messages</strong>.
        </P>
        <P>
          The <strong>Pins</strong> tab shows values the agent has surfaced via{" "}
          <Code>dispatch_pin</Code> — URLs, ports, branch names, file paths, and
          other key info. Setting a pin again with the same label updates it in
          place, <Code>dispatch_pins</Code> writes a whole set at once, and
          agents can remove stale pins with <Code>dispatch_list_pins</Code> +{" "}
          <Code>dispatch_delete_pin</Code>. Agents can also pin a{" "}
          <strong>shortcut</strong> — a button that injects a prompt into that
          agent's session when you click it, exactly as if you had typed it
          yourself. Hovering shows the full prompt before you commit, shortcuts
          the agent marks as risky ask you to confirm first, and they're
          disabled while the agent isn't running. An agent can also grey out a
          shortcut of its own once the action no longer applies, leaving the
          caption to explain why. Any pin can also carry a one-line markdown
          caption, and pins sharing a <Code>group</Code> render together under
          one collapsible heading with a member count — groups of more than
          eight pins start collapsed, and your own expand/collapse choice sticks
          per agent and group. The <strong>Media</strong> tab shows shared files
          in reverse chronological order (most recent 50); click an item to open
          the full-screen lightbox. Items you haven't seen yet are highlighted,
          and the tab shows an unseen count. The <strong>Reviews</strong> tab
          shows human review feedback submitted from the Changes tab — each
          review has a status badge (open, partially resolved, or resolved), and
          you can expand it to see individual items, threaded messages, diff
          snapshots, and resolutions. Click a file path to jump to that location
          in the Changes tab. The <strong>Messages</strong> tab shows
          inter-agent messages grouped by conversation partner — sent and
          received messages appear in chat-style bubbles with timestamps and
          delivery status. Unread messages show a badge count on the tab.
        </P>
        <P>
          The sidebar opens in <strong>drawer</strong> mode by default —
          floating over the terminal without shifting the layout. Click the pin
          icon in the sidebar header to switch to <strong>pinned</strong> mode,
          which takes layout space and shrinks the terminal to make room. Click
          the unpin icon to switch back. On mobile the sidebar always opens as a
          full-screen overlay.
        </P>
        <P>
          The <strong>Share file</strong> button at the top of the Media tab
          lets you upload a file directly to the agent's media store (stored
          with <Code>source: "user"</Code>). These uploads are not injected into
          the terminal — see <em>Uploading files to agents</em> above for
          methods that inject automatically.
        </P>
      </Section>
    </>
  );
}
