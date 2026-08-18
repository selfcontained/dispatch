import { Code, H3, P, Section } from "./primitives";

export function ShortcutsContent() {
  return (
    <>
      <P>
        Dispatch registers a small set of global keyboard shortcuts that fire
        from anywhere in the page — including text inputs and the xterm terminal
        — because they listen in the <em>capture</em> phase of the document. To
        suppress them inside a particular subtree (e.g. a modal), mark the
        subtree root with <Code>data-hotkey-disable=&quot;true&quot;</Code>.
      </P>

      <Section>
        <H3>Keyboard shortcuts</H3>
        <P>
          On macOS, <Code>Mod</Code> is <Code>⌘</Code>. On Windows/Linux it is{" "}
          <Code>Ctrl</Code>.
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <Code>Mod+K</Code> — Open the command palette.
          </li>
          <li>
            <Code>Mod+Shift+Space</Code> — Focus the terminal input.
          </li>
          <li>
            <Code>Mod+Shift+&gt;</Code> — Toggle the media sidebar.
          </li>
          <li>
            <Code>Mod+Shift+&lt;</Code> — Toggle the agent sidebar.
          </li>
          <li>
            <Code>Mod+Shift+↑</Code> — Focus the previous agent (cycles through
            sidebar cards only; sub agent rows are skipped, and selecting one
            anchors the cycle to the card it lives in).
          </li>
          <li>
            <Code>Mod+Shift+↓</Code> — Focus the next agent.
          </li>
        </ul>
      </Section>

      <Section>
        <H3>Command palette</H3>
        <P>
          Press <Code>Mod+K</Code> to open the palette. It shows a searchable
          list of actions — type to filter, then press Enter or click to run
          one.
        </P>
        <P>
          Templates with <strong>Show in command palette</strong> enabled appear
          in a <em>Templates</em> group below the built-in commands. Templates
          without arguments show a confirmation step — press Enter twice to
          launch immediately. Templates with arguments open a launch dialog
          where you fill in each value before launching.
        </P>
      </Section>
    </>
  );
}
