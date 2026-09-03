import { Code, H3, P, Section } from "./primitives";

export function AgentSurfacesContent() {
  return (
    <>
      <P>
        Agents can author custom tabs in the media sidebar to present
        structured, interactive work — status, progress, tables, forms, and
        action buttons — instead of only chat and pins. The owning agent builds
        and updates the document; you interact with it and the agent reads back
        whatever you submit or click.
      </P>

      <Section>
        <H3>Where surfaces appear</H3>
        <P>
          Custom tabs render in the same sidebar as <strong>Pins</strong>,{" "}
          <strong>Media</strong>, <strong>Reviews</strong>, and{" "}
          <strong>Messages</strong> (see the Media & Sharing section), one tab
          per surface the agent has created. An agent may have up to 8 active
          surfaces at a time. A tab with unresolved interactions shows a count
          badge; use the overflow menu at the end of the tab strip to jump to a
          tab, reorder tabs, hide ones you don't need visible, or reset back to
          the agent's own order — these are local display preferences and don't
          change what the agent sees.
        </P>
      </Section>

      <Section>
        <H3>Document layout</H3>
        <P>
          Every surface shares one geography: an optional <Code>header</Code>{" "}
          (the headline status and progress strip) renders first, the{" "}
          <Code>blocks</Code> body follows, and an optional <Code>footer</Code>{" "}
          holds the surface's action buttons — rendered as a compact split
          button whose extra and destructive verbs live in an overflow menu.
          Sections can carry their own footer actions scoped to their group.
        </P>
      </Section>

      <Section>
        <H3>Block types</H3>
        <P>
          The body is built from blocks: <Code>text</Code> for short Markdown (a{" "}
          <Code>tone</Code> renders it as a callout), <Code>status</Code> for
          one current state with a tone, <Code>progress</Code> for a bounded
          progress bar, <Code>list</Code> for bullets, steps, or checklist-style
          items (each optionally carrying a status, a link, or its own actions —
          one renders inline, more become a per-item menu), <Code>table</Code>{" "}
          for compact repeated data with badge-formatted cells (up to three
          visible columns; two-column tables render as a key/value list),{" "}
          <Code>form</Code> for text, textarea, number, checkbox, radio, and
          select fields submitted together, and <Code>section</Code> to group
          related blocks under a title, optionally collapsed. Secondary table
          columns stay hidden behind a per-row disclosure until you expand it. A
          tab authored under an older surface format shows a notice asking the
          agent to recreate it.
        </P>
      </Section>

      <Section>
        <H3>Submitting and acting</H3>
        <P>
          Clicking an action button or submitting a form sends a durable
          interaction back to the owning agent — it queues even if the agent is
          idle or stopped, and is delivered once it resumes. Actions marked
          consequential ask you to confirm first. A form's{" "}
          <Code>submitMode</Code> determines whether it resets after sending
          (repeatable intake) or is meant for a single decision. The agent
          claims your interaction before acting on it and resolves it with a
          short outcome message, then updates the surface to reflect what
          happened — nothing is inferred on your behalf. An agent can freeze a
          surface to keep it visible but stop accepting input; a frozen tab is
          shown as archived and read-only.
        </P>
      </Section>
    </>
  );
}
