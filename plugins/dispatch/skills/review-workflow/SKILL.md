---
name: review-workflow
description: Open a pull request and get the change reviewed in Dispatch, then work the findings. Use when wrapping up a change, about to open a PR, or when a review block has come back to respond to.
---

# Pull requests and review in Dispatch

Two habits Dispatch adds to the usual wrap-up:

1. **Post the PR into the stream.** Open it with the `gh` CLI, then `post` it
   as a `pr` attachment so the user can reach it from the stream and the rail.
2. **Get reviewed by launching a persona**, not by re-reading your own diff.
   A reviewer persona posts one `review` block back to you: a verdict, a
   summary, and findings that each carry their own thread.

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

```
list_personas — what reviewers exist here, with their descriptions
launch_agent  persona: <slug>, name, prompt, includeDiff?, type?, model?
```

Call `list_personas` first and **launch one reviewer per distinct scope the
change touches** — a change spanning backend and frontend gets both; anything
cross-cutting or introducing a new module also gets an architecture pass.
Reviewers with different lenses barely overlap in what they find, and the one you
almost skipped is often the one that finds the real defect. Launch them in the
same turn rather than serially.

If nothing matches well, launch the closest persona anyway and say so plainly in
the briefing. Skipping review because the fit is imperfect is worse than an
imperfect reviewer. To write a better-fitting one, see the `personas` skill.

### The briefing is the whole game

`prompt` is the reviewer's briefing, and it is what separates a review that
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

The review arrives as a DISPATCH POST carrying a `review` block: `verdict`
(`approve`, `request_changes`, `comment`), `summary`, and `findings`, each with
an `id`, `severity`, `title`, `body`, and often a `path` and `line`. Each
finding is a thread under that block.

```
post    replyTo: <review block id>, finding: <findingId>, text
        — discuss a finding in its own thread
update  id: <review block id>,
        state: { findings: { <findingId>: "fixed" } }
        state: { findings: { <findingId>: { status: "resolved",
                 resolution: "dismissed", note: "why" } } }
        state: { findings: { <findingId>: "open" } }   — reopen
```

A review is open until a finding is resolved, partially resolved while some
are, and resolved once every one is fixed or dismissed.

**Keep the discussion in the thread.** A reply with `replyTo` reaches the
reviewer as a prompt and keeps the finding, the fix, and the verification
attached to each other; a loose post does neither.

**After fixing a finding, say what you changed in the thread, then mark it
`fixed`.** The reviewer can reopen it (`"open"`, with a note) if the fix falls
short, so a resolution is a claim it will check, not the end of the conversation.

**Not every finding has to be accepted.** When you disagree, dismiss it with a
note saying why, and give the evidence in the thread — what the system actually
does, what the API or database will actually accept. A reviewer given a real
rebuttal will concede, and that exchange is worth more than silently complying
with a wrong finding. When a finding asserts a failure mode rather than pointing
at visible broken behavior, measure the real system to settle it.

Verify each fix the same way you verified the original work. Collapsing two
constraints that merely looked alike, or hoisting an invariant into a shared
helper, is exactly how a review fix introduces a regression of its own.

## Autonomous Review

When Autonomous Review is enabled for a session, its launch guidance spells out
the loop: commit and push, open a draft PR and post it, launch the reviewers,
then let the turn end — each review arrives as a prompt when the reviewer posts
it, so there is nothing to poll. A clean `approve` with no findings needs no
action; otherwise work the findings above. Don't report the task complete while
a finding is still open.

## Cleaning up

Once a reviewer's block is in your stream, `archive_agent` retires the
reviewer. See the `subagents` skill.
