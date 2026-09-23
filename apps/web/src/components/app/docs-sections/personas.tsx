import { Code, CodeBlock, H3, P, Section } from "./primitives";

export function PersonasContent() {
  return (
    <>
      <P>
        Personas are reusable launch profiles defined per repository. Each one
        looks at work from a specific perspective — for example, security, UX,
        or architecture. A persona agent runs as a child of the agent that
        launched it and posts what it produces into that agent&apos;s stream; a
        reviewer persona posts one <Code>review</Code> block.
      </P>

      <Section>
        <H3>How personas work</H3>
        <P>
          An agent calls <Code>launch_agent</Code> with{" "}
          <Code>persona: &lt;slug&gt;</Code>; the <Code>prompt</Code> is the
          persona&apos;s briefing. Dispatch loads the persona definition from
          the repo and spawns a child agent with the persona&apos;s
          instructions, the briefing, and (by default) a diff of the current
          changes against the agent&apos;s base branch. Reviewers always get the
          exact local <Code>git diff</Code> commands to reproduce what they are
          seeing. Small diffs are also included inline; large diffs (over ~15
          KB) are replaced with a file-level summary plus those commands so the
          reviewer can inspect specific files in the worktree. Pass{" "}
          <Code>includeDiff: false</Code> for non-code work (PRDs, docs, images)
          where the git diff is not the subject.
        </P>
        <P>
          Persona agents run as <Code>claude</Code> or <Code>codex</Code> agents
          like any other; the launcher lets you pick which.
        </P>
        <P>
          From the UI, the <strong>Launch personas</strong> button on the
          Changes tab (and the <strong>Review</strong> button on an agent&apos;s
          detail card) opens a dialog where persona rows are checkboxes — select
          one or more and a single launch starts every selected persona as its
          own child. Alongside the agent-type picker, a <strong>Model</strong>{" "}
          selector appears for types with a curated model catalog; leave it on{" "}
          <strong>Default</strong> for the CLI&apos;s own setting (the choice is
          remembered per repo and agent type). An optional{" "}
          <strong>focus note</strong> — free text like &quot;focus on the auth
          changes&quot; — is folded into the briefing every selected persona
          receives, and the <strong>Include the current diff</strong> toggle
          maps to <Code>includeDiff</Code>.
        </P>
        <P>
          Persona agents share files and screenshots the same way every agent
          does — a <Code>post</Code> with a file attachment — and have{" "}
          <Code>list_files</Code> to inspect what has been shared with them.
          Each file item includes an absolute <Code>filePath</Code> and{" "}
          <Code>sizeBytes</Code> so a reviewer can open or inspect the artifact
          directly — useful for doc-centric review flows.
        </P>
      </Section>

      <Section>
        <H3 id="built-in-reviewer">The built-in reviewer</H3>
        <P>
          Dispatch ships one persona of its own:{" "}
          <strong>General Code Review</strong> (slug <Code>code-review</Code>).
          It is a repo-agnostic generalist — correctness, clarity, and fit with
          the surrounding code — and it is available in every repository, so
          review works before anyone writes a persona file. It also stays in the
          picker next to repo-defined personas as the &quot;just review this
          generally&quot; option.
        </P>
        <P>
          A <Code>.dispatch/personas/code-review.md</Code> file replaces it
          entirely, which is how a project specializes the generic reviewer
          without changing the slug agents and the UI already use.
        </P>
      </Section>

      <Section>
        <H3>Defining personas</H3>
        <P>
          Each repo defines its own personas as markdown files in{" "}
          <Code>.dispatch/personas/</Code>. The filename (without extension)
          becomes the persona slug used when launching. Files use YAML
          frontmatter for metadata and the body is the persona&apos;s
          instructions. Dispatch automatically appends the briefing and the
          current diff, plus a standard block of guidance on posting the review
          — persona files should not include their own context or diff
          placeholders.
        </P>
        <CodeBlock>{`
# .dispatch/personas/security-review.md
---
name: Security Review
description: Reviews code for security vulnerabilities
feedbackFormat: findings
---

You are a security reviewer. Analyze the changes below for
vulnerabilities, injection risks, and auth issues. Flag only
issues caused or worsened by this diff.`}</CodeBlock>
        <P>
          The <Code>name</Code> and <Code>description</Code> fields are shown in
          the persona picker UI. The <Code>feedbackFormat</Code> field is
          optional and defaults to <Code>findings</Code>.
        </P>
        <P>
          Agents can author personas too: standard agents and jobs get{" "}
          <Code>persona_templates</Code> (short built-in starting points),{" "}
          <Code>persona_upsert</Code> (create or update a persona file in the
          agent&apos;s checkout), and <Code>persona_validate</Code> (check every
          persona file for required metadata) MCP tools, so you can ask an agent
          to draft a repo-specific reviewer instead of writing the markdown
          yourself.
        </P>
      </Section>

      <Section>
        <H3>The review block</H3>
        <P>
          When its pass is complete, a reviewer posts exactly one{" "}
          <Code>review</Code> block to the agent that launched it:{" "}
          <Code>
            {
              "post({ to, review: { summary, findings: [{ severity, title, body, path?, line? }] } })"
            }
          </Code>
          . Each finding has a severity of <Code>blocker</Code>,{" "}
          <Code>major</Code>, <Code>minor</Code>, or <Code>nit</Code>, a
          concrete comment, and optionally a file path and line, and becomes a
          block of its own with its own thread. A reviewer that finds no issues
          posts a review with no findings; the summary then carries the
          assessment.
        </P>
        <P>
          The reviewer is a child agent, so the review lands on its launch card
          — the one entry for the reviewer in the stream, which also holds its
          briefing, startup and instructions. The card shows the review as one
          line — its status, summary, <em>n findings · m open</em> — and opens
          into its thread, where the finding rows are. The status comes from the
          findings alone: <strong>Changes requested</strong> while any is open,{" "}
          <strong>Approved</strong> once every one is fixed or dismissed. Click
          a finding to open its own thread, or its path to jump to that line in
          the Changes tab.
        </P>
      </Section>

      <Section>
        <H3>Review lifecycle</H3>
        <P>
          The agent that received the review answers each finding in the
          finding&apos;s thread (<Code>post</Code> with <Code>replyTo</Code> set
          to the finding&apos;s id): what it changed, or why it disagrees. Each
          comment reaches the other side as a prompt, and a comment you write
          reaches both. The reviewer checks the answer and settles the finding
          with <Code>update</Code> on it (
          <Code>{'{ id: <finding id>, state: { status: "fixed" } }'}</Code>, or{" "}
          <Code>{'{ status: "dismissed", note }'}</Code>), or says under it what
          is still missing and reopens it (
          <Code>{'{ status: "open", note }'}</Code>), which tells the agent
          whose work it is. You can resolve, dismiss or reopen a finding from
          its thread too.
        </P>
        <P>
          You can also leave a review by hand from the Changes tab:{" "}
          <strong>Leave a review</strong> enters review mode, where each line
          comment you add becomes a draft finding; <strong>Post review</strong>{" "}
          asks for a summary and posts the same kind of <Code>review</Code>{" "}
          block, addressed to the agent.
        </P>
      </Section>
    </>
  );
}
