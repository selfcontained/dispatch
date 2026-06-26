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
          The child reviews the work, pings progress with{" "}
          <Code>review_status</Code>, submits findings via{" "}
          <Code>dispatch_feedback</Code>, and finishes with{" "}
          <Code>dispatch_complete_review</Code>. Pass{" "}
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
          Persona agents submit findings with the <Code>dispatch_feedback</Code>{" "}
          tool. Each finding includes a severity (<Code>critical</Code>,{" "}
          <Code>high</Code>, <Code>medium</Code>, <Code>low</Code>,{" "}
          <Code>info</Code>), a description, and optionally a file path, line
          number, and suggested fix. Findings appear in the Feedback panel where
          you can review and resolve them.
        </P>
        <P>
          Each finding can be marked <strong>Fixed</strong>,{" "}
          <strong>Ignored</strong> (requires a reason), or forwarded to the
          agent. Resolved items show a status badge and — when resolved via the
          round-trip flow — display the resolution reason and the commit SHA
          that was submitted. Items marked Ignored include the reason inline so
          the reviewer sees it during recheck.
        </P>
      </Section>

      <Section>
        <H3>Review lifecycle</H3>
        <P>
          Persona agents ping progress with the <Code>review_status</Code> tool
          — a short <Code>message</Code> each time the reviewer shifts to a
          distinct phase (e.g. "Reading diff", "Running tests"). To finish, they
          call <Code>dispatch_complete_review</Code> with a <Code>verdict</Code>{" "}
          of <Code>approve</Code> or <Code>request_changes</Code>, a{" "}
          <Code>summary</Code>, and optionally a list of{" "}
          <Code>filesReviewed</Code>. The verdict and summary show up on the
          review agent's card in the UI.
        </P>
      </Section>

      <Section>
        <H3>Round-trip reviews</H3>
        <P>
          When a reviewer finishes round 1 with <Code>request_changes</Code> (or{" "}
          <Code>approve</Code> with feedback), the review enters a recheck pass.
          The reviewer stays alive, waiting for the parent to resolve feedback
          and submit a resolution — then performs a second pass and emits a
          final verdict. If the reviewer approves with no feedback, the recheck
          is skipped and the review completes immediately.
        </P>
        <P>
          The handoff is push-based: when each round transitions, the server
          injects a fresh prompt into the receiving agent's terminal. There is
          no tool to poll. The parent uses these tools to act on each prompt as
          it arrives:
        </P>
        <ul className="grid gap-1.5 pl-4 text-sm text-muted-foreground list-disc">
          <li>
            <Code>dispatch_get_feedback</Code> — read the findings for a
            specific review when the round-1 prompt arrives.
          </li>
          <li>
            <Code>dispatch_resolve_feedback</Code> — mark each item{" "}
            <Code>fixed</Code> or <Code>ignored</Code>. Ignored items require a{" "}
            <Code>reason</Code>; the reviewer sees it on round 2.
          </li>
          <li>
            <Code>dispatch_submit_resolution</Code> — commit your fixes first,
            then submit a 1–3 sentence <Code>summary</Code>. The server captures
            the current HEAD as the resolution commit, and the reviewer's
            round-2 diff is computed from there. Submitting with uncommitted
            changes gives the reviewer an empty diff, and it will re-flag the
            same issues.
          </li>
          <li>
            <Code>dispatch_cancel_recheck</Code> — abort the loop so the
            reviewer exits cleanly.
          </li>
        </ul>
        <P>
          For round 2, the server pushes a prompt into the reviewer's terminal
          telling it to call <Code>dispatch_get_recheck_context</Code> — that
          tool returns the parent's resolution summary, per-item resolutions,
          and the exact commit range to inspect with <Code>git diff</Code>{" "}
          locally. The reviewer re-checks each original finding (linking any new
          feedback back to the original via <Code>respondsToFeedbackId</Code>)
          and calls <Code>dispatch_complete_review</Code> a second time with a
          final verdict — at which point the server pushes a final prompt into
          the parent's terminal. Round number, the parent's resolution, and the
          round-2 verdict are stacked on the reviewer's card in the UI; the row
          also highlights while a review is in progress.
        </P>
      </Section>
    </>
  );
}
