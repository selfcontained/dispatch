import { Code, CodeBlock, H3, P, Section } from "./primitives";

export function PersonasContent() {
  return (
    <>
      <P>
        Personas are reusable agent roles defined per repository. Each persona
        reviews work from a specific perspective — for example, security, UX, or
        architecture. A persona agent runs as a child of the agent that launched
        it and submits structured feedback.
      </P>

      <Section>
        <H3>How personas work</H3>
        <P>
          An agent calls the built-in <Code>dispatch_launch_persona</Code> tool,
          passing the persona name and a context briefing. Dispatch loads the
          persona definition from the repo and spawns a new child agent with the
          persona's instructions, the parent's context, and (by default) a diff
          of the current changes against the agent's base branch. Reviewers
          always get the exact local <Code>git diff</Code> commands to reproduce
          what they are seeing. Small diffs are also included inline; large
          diffs (over ~15 KB) are replaced with a file-level summary plus those
          commands so the reviewer can inspect specific files in the worktree.
          The child reviews the work and calls{" "}
          <Code>dispatch_review_submit</Code> once with every initial finding.
          The summary is optional when feedback items carry the review, and
          required for a clean approval with no items. Pass{" "}
          <Code>includeDiff: false</Code> for non-code reviews (PRDs, docs,
          media) where the git diff is not the review target.
        </P>
        <P>
          Reviewers always run as a CLI-type agent (claude / codex / cursor /
          opencode); the launcher only offers types that have a CLI assistant,
          so terminal-type agents are not selectable as reviewers.
        </P>
        <P>
          Persona agents also have <Code>dispatch_pin</Code> and{" "}
          <Code>dispatch_share</Code> for surfacing files or screenshots, and{" "}
          <Code>get_parent_context</Code> to retrieve the parent agent's pins
          and shared media (for example, a dev server URL to test against). Each
          media item also includes an absolute <Code>filePath</Code> and{" "}
          <Code>sizeBytes</Code> so reviewers can open or inspect the artifact
          directly — useful for doc-centric review flows.
        </P>
      </Section>

      <Section>
        <H3>Defining personas</H3>
        <P>
          Each repo defines its own personas as markdown files in{" "}
          <Code>.dispatch/personas/</Code>. The filename (without extension)
          becomes the persona slug used when launching. Files use YAML
          frontmatter for metadata and the body is the persona's instructions.
          Dispatch automatically appends the parent agent's context and the
          current diff, plus a standard block of feedback guidance — persona
          files should not include their own context or diff placeholders.
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
      </Section>

      <Section>
        <H3>Submitting findings</H3>
        <P>
          <Code>dispatch_review_submit</Code> creates the review record only
          after the reviewer has completed its initial pass. Each optional
          feedback item contains a concrete comment and may include a file path
          and line range. A reviewer that finds no issues submits an empty
          feedback array; Dispatch still records its summary as a resolved
          approval.
        </P>
        <P>
          After submission, <Code>dispatch_review_add_feedback</Code> adds only
          a genuinely new concern. Clarifying questions and replies belong in
          the existing item's tracked thread via{" "}
          <Code>dispatch_review_add_message</Code>.
        </P>
      </Section>

      <Section>
        <H3>Review lifecycle</H3>
        <P>
          Reviews use the same flexible feedback-item model whether the reviewer
          is a human or an agent. The parent reads the current state with{" "}
          <Code>dispatch_review_list_feedback</Code>, converses through each
          item's thread, and sets the outcome with{" "}
          <Code>dispatch_review_resolve</Code>. Use{" "}
          <Code>dispatch_review_reopen</Code> if a resolved concern needs more
          work. Review status is derived automatically: open while any item is
          open, partially resolved when only some are resolved, and resolved
          when every item is resolved.
        </P>
        <P>
          Every review action is push-based. Dispatch injects clearly delimited
          blocks when a review is submitted, a thread receives a message, or an
          item is resolved or reopened. This keeps both agents aware without
          using direct messages or imposing a fixed round/recheck sequence.
        </P>
      </Section>
    </>
  );
}
