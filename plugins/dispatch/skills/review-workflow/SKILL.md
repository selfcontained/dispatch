---
name: review-workflow
description: Open a pull request and get the change reviewed in Dispatch, then work the findings. Use when wrapping up a change, about to open a PR, or when a review block has come back to respond to.
---

# Pull requests and review in Dispatch

Two habits Dispatch adds to the usual wrap-up:

1. **Post the PR into the stream.** Open it with the `gh` CLI, then `post` it
   as a `pr` attachment so the user can reach it from the stream and the Inbox.
2. **Get reviewed by launching a persona**, not by re-reading your own diff.
   A reviewer persona posts one `review` block back to you: a summary, and
   findings that are each a block with its own thread.

## Opening the PR

```
gh pr create --draft --title "…" --body "…"
post  attachments: [{ type: "pr", url: "<the PR url>" }]
```

Commit and push your branch first. Let `gh` pick the base from the repo's
default branch unless you specifically mean to target something else — an
overridden base is the usual cause of a PR containing someone else's commits.
`gh pr checks` and `gh pr view` answer CI and merge-state questions.

## Getting it reviewed

For code changes in a repo with `.dispatch/codeowners.json`, use:

```
launch_owner_reviews context, dryRun?, agentType?, model?
```

Dispatch collects committed changes against the review base, uncommitted changes,
and untracked files, then launches every matching code owner once. Each owner
gets your briefing and its matched files through the ordinary ACP persona launch.
The result includes uncovered files, selected owners, launched agents, and any
launch failures. Use `dryRun: true` to preview selection without launching.
Fix invalid configuration or launch failures before treating a pass as complete.
After a partial failure, retry failed personas individually with `launch_agent`
rather than duplicating successful launches.

If the repo has no ownership map, or you need an explicitly requested additional
perspective, use `list_personas` and `launch_agent` with a specific `persona`.
Prefer subsystem experts with concrete invariants over generic role labels.
The built-in `code-review` is available when no specialized persona fits.

Ownership configuration is documented in `docs/code-owner-reviews.md` in the
Dispatch repository. After launching all reviewers for a pass, end the turn;
Dispatch delivers their review blocks automatically. Do not poll or wait.

### The briefing is the whole game

`context` on `launch_owner_reviews` (or `prompt` on a manual launch) is the reviewer's briefing, and it is what separates a review that
finds defects from one that returns a summary. Include:

- **What changed**, and the key files — actual paths.
- **What is out of scope**, explicitly. Otherwise reviewers flag pre-existing
  issues and you spend a round sorting them out.
- **Decisions already made, and the alternatives that were rejected.** Without
  this, reviewers re-propose the rejected option and you relitigate a settled
  call.
- **The specific properties you want attacked** — the edge cases in new parsing
  logic, the trust boundary a caller-supplied value now crosses, the invariant a
  shared helper now owns. A briefing that only describes the change gets a
  summary back; one that poses questions gets findings.

Set `includeDiff: false` only for non-code reviews (a plan, a document, images)
where a code change is not the review target. When it is on, the reviewer gets a
file-level map of the change and the git commands to read it — never the diff
itself, since it is already in the worktree.

## Working the review

After launching reviewers, finish independent work and end the turn when the
next step depends on their findings. Reviews arrive as new prompts; do not
sleep or poll for them. A launch receipt or progress reply is not a review.

The review arrives as a DISPATCH POST carrying a `review` block: its
`summary`, and its findings, each with its own `id`, `severity`, `title`,
`body`, and often a `path` and `line`. Each finding is a block of its own, and
its thread is where it is discussed.

```
post    to: <reviewer agent id>, replyTo: <finding id>, text
        — answer a finding in its thread and deliver it to the reviewer
```

Where a review stands comes from its findings: open until one is resolved,
partially resolved while some are, and resolved once every one is fixed or
dismissed. **The reviewer resolves them, not you**: it checks your answer and
settles the finding, or tells you under it what is still missing and reopens
it.

**Keep the discussion in the finding's thread.** Use `replyTo` for the thread
and `to` for delivery to the reviewer. This keeps the finding, the fix, and the verification
attached to each other; a loose post does neither. Don't narrate in the review's
own thread.

**After fixing a finding, say what you changed under it.** That is the claim the
reviewer checks, so say enough for it to verify: the file, the behavior, the
test. Once the reviewer resolves it, there is nothing to answer.

**Not every finding has to be accepted.** When you disagree, say why under the
finding and give the evidence — what the system actually does, what the API or
database will actually accept. A reviewer given a real rebuttal will dismiss it,
and that exchange is worth more than silently complying with a wrong finding.
When a finding asserts a failure mode rather than pointing at visible broken
behavior, measure the real system to settle it.

Verify each fix the same way you verified the original work. Collapsing two
constraints that merely looked alike, or hoisting an invariant into a shared
helper, is exactly how a review fix introduces a regression of its own.

## Autonomous Review

When Autonomous Review is enabled for a session, its launch guidance spells out
the loop: commit and push, open a draft PR and post it, launch the reviewers,
then let the turn end — each review arrives as a prompt when the reviewer posts
it, so there is nothing to poll. A review with no findings needs no action;
otherwise work the findings above. Don't report the task complete while a
finding is still open.

## Cleaning up

The reviewer is the one who resolves its findings, so keep it running until its
review is resolved; then `archive_agent` retires it. See the `subagents` skill.
