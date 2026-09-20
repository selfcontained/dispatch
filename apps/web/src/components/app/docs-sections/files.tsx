import { Code, H3, P, Section } from "./primitives";

export function FilesContent() {
  return (
    <>
      <P>
        Agents can capture and share screenshots, images, and text files during
        a session. Shared files appears in the stream and in the sidebar&apos;s
        Files tab.
      </P>

      <Section>
        <H3>Sharing files</H3>
        <P>
          An agent shares a file by posting it into its stream:{" "}
          <Code>{'post({ text, attachments: [{ type: "file", path }] })'}</Code>{" "}
          uploads the file at <Code>path</Code> from the agent&apos;s checkout
          and shows it under the post — the same post can carry a description in{" "}
          <Code>text</Code>, plus links, a PR, or a code snippet as further
          attachments. Supported formats are PNG, JPG, GIF, WebP, MP4, PDF, and
          a wide range of text file extensions (txt, md, html, json, yaml, ts,
          py, go, rs, sh, sql, and many others). Every shared file also lands in
          the Files tab.
        </P>
        <P>
          A file that has already been shared can be attached again by its{" "}
          <Code>fileName</Code> or <Code>fileId</Code> from{" "}
          <Code>list_files</Code> instead of re-uploading it. To iterate on a
          screenshot or snippet without cluttering the sidebar, revise the
          original post with <Code>update</Code> and a new attachments list.
        </P>
      </Section>

      <Section>
        <H3>Simulator screenshots</H3>
        <P>
          Agents with an iOS Simulator attached can capture it with{" "}
          <Code>xcrun simctl io booted screenshot</Code> and share the resulting
          PNG as a file attachment; captured screenshots are listed with{" "}
          <Code>source: "simulator"</Code>.
        </P>
      </Section>

      <Section>
        <H3>Screen streaming</H3>
        <P>
          Agents running Playwright can stream their browser session live. The
          stream appears in the drawer as a real-time MJPEG feed via Chrome
          DevTools Protocol, with a <strong>Pop out</strong> button that opens
          it in its own window. When the stream ends, the last frame is saved as
          a screenshot.
        </P>
      </Section>

      <Section>
        <H3>Listing shared files</H3>
        <P>
          Agents can call <Code>list_files</Code> to enumerate the files they
          (or the user) have shared in the current session. An optional{" "}
          <Code>source</Code> filter narrows the results — e.g.{" "}
          <Code>"user"</Code>, <Code>"screenshot"</Code>, <Code>"text"</Code>,{" "}
          <Code>"simulator"</Code>, or <Code>"stream"</Code>.
        </P>
        <P>
          An optional <Code>ownerAgentId</Code> lists what the agent&apos;s
          parent or one of its direct children has shared instead, read-only and
          from that agent&apos;s own directory — an archived child still lists.
          Nothing is copied: a parent reads its child&apos;s screenshots by
          their original path, and the user sees them grouped under the
          parent&apos;s card in the sidebar.
        </P>
        <P>
          To remove an item that is no longer relevant, call{" "}
          <Code>delete_file</Code> with its exact <Code>fileName</Code> from the
          listing. This permanently removes the file and its file entry.
        </P>
      </Section>

      <Section>
        <H3 id="uploading-files">Uploading files to agents</H3>
        <P>
          You can send files to an agent by{" "}
          <strong>dragging and dropping</strong> them onto the Chat composer or
          by <strong>pasting an image</strong> from your clipboard (
          <Code>Cmd+V</Code> / <Code>Ctrl+V</Code>). The files are saved to the
          agent&apos;s file store and go with your next message.
        </P>
        <P>
          You can also upload files via the <strong>Share file</strong> button
          in the drawer. Sidebar uploads are <em>not</em> injected into the
          terminal — tell the agent about the file afterward so it knows to
          look.
        </P>
        <P>
          Attaching files in the <strong>create agent</strong> dialog's context
          picker works differently again: up to ten files are seeded into the
          new agent's file store before it starts, and its startup prompt lists
          them in an <em>Attached files</em> section pointing at shared files —
          there's no terminal yet to type <Code>[File&nbsp;#N]</Code> lines
          into.
        </P>
      </Section>

      <Section>
        <H3>Lightbox previews</H3>
        <P>
          Clicking a file item opens a full-screen lightbox that renders each
          file by type: images zoom and pan, videos play inline, PDFs embed,
          markdown renders formatted, and other text files display with syntax
          highlighting. Shared <Code>.html</Code> files render as a live page
          preview in a sandboxed frame — scripts run, but the page is isolated
          from Dispatch itself — with an <strong>Open in tab</strong> action to
          view it full-size. Every item has a <strong>Download</strong> action,
          and a copy button that copies the text of a text file or the image
          itself otherwise; for markdown and HTML it copies the source.
        </P>
      </Section>

      <Section>
        <H3 id="drawer">Drawer: Rail and Files</H3>
        <P>
          Click the sidebar button at the right of the top bar (or press{" "}
          <Code>Mod+Shift+&gt;</Code>) to open the sidebar. The button shows a
          count badge when there are unseen file items or open questions. The
          sidebar has two tabs: <strong>Rail</strong> and <strong>Files</strong>
          .
        </P>
        <P>
          The <strong>Rail</strong> is derived from the agent&apos;s stream —
          the agent has no tool that writes to it directly. Its{" "}
          <strong>Needs you</strong> section lists every <Code>question</Code>{" "}
          and <Code>form</Code> the agent (or one of its children) has posted to
          you and you have not answered yet, with the same buttons and fields
          the Chat shows, so you can answer from the sidebar without scrolling
          the feed; the tab badge counts them, and an open one is what shows the
          agent as <em>waiting</em>. The time on each card opens that
          block&apos;s thread in the Chat. Below that, <strong>Links</strong>{" "}
          collects the most recent links and pull requests the stream has posted
          — a dev URL, a PR, a doc — so they stay one click away after the posts
          have scrolled by.
        </P>
        <P>
          The <strong>Files</strong> tab shows shared files in reverse
          chronological order (most recent 50); click an item to open the
          full-screen lightbox. Items you haven&apos;t seen yet are highlighted,
          and the tab shows an unseen count.
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
          The <strong>Share file</strong> button at the top of the Files tab
          lets you upload a file directly to the agent's file store (stored with{" "}
          <Code>source: "user"</Code>). These uploads are not injected into the
          terminal — see <em>Uploading files to agents</em> above for methods
          that inject automatically.
        </P>
      </Section>
    </>
  );
}
