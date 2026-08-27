---
name: review-workflow
description: Open a pull request and get the change reviewed in Dispatch, then work the findings. Use when wrapping up a change, about to open a PR, or when review feedback has come back to respond to.
---

# Pull requests and review in Dispatch

Dispatch has its own PR and review path. Two habits it overrides:

1. **Open PRs with `create_pr`**, not with a built-in PR skill and not with the
   `gh` CLI. `create_pr` is what registers the PR with Dispatch, so it shows up
   in the UI and in review tracking.
2. **Get reviewed by launching a persona**, not by re-reading your own diff.
   Reviews launched with `dispatch_launch_persona` come back as structured,
   trackable feedback items with their own discussion threads.

## Opening the PR

```
create_pr  title?, body?, baseBranch?, draft?, fillFromCommits?
get_pr_status  — status details for an existing PR
```

`baseBranch` defaults correctly for the current worktree. **Do not override it**
unless you specifically mean to target something other than the repo's default
branch — an overridden base is the usual cause of a PR containing someone else's
commits.

Commit and push your branch before calling it. Pin the returned PR link so the
user can reach it from the sidebar.

## Getting it reviewed

```
list_personas          — what reviewers exist here, with their descriptions
dispatch_launch_persona persona, context, includeDiff?, agentType?, model?
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

`context` is what separates a review that finds defects from one that returns a
summary. Include:

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

Set `includeDiff: false` only for non-code reviews (a plan, a document, media)
where a code change is not the review target. When it is on, the reviewer gets a
file-level map of the change and the git commands to read it — never the diff
itself, since it is already in the worktree.

## Working the feedback

```
dispatch_review_list_feedback  reviewId? — item ids, locations, status
dispatch_review_get_feedback   id — full thread plus the captured diff hunk
dispatch_review_add_message    id, message — reply in the item's thread
dispatch_review_resolve        id — reviewer-side: mark fixed or dismissed
dispatch_review_reopen         id — more work or discussion needed
```

`dispatch_review_list_feedback` finds items; `dispatch_review_get_feedback` gives
you the one you are about to work, including the diff hunk captured when it was
filed.

**Keep all discussion in the item thread.** That is where the reviewer is
listening, and it keeps the finding, the fix, and the verification attached to
each other.

**After fixing an item, ask the reviewer to verify it — do not resolve it
yourself.** Post a short `dispatch_review_add_message` saying what you changed;
the reviewer re-inspects and resolves, or replies with what is still missing.
Replies are capped around 600 characters: state the decision or result, and skip
restating the feedback or narrating the work.

**Not every finding has to be accepted.** When you disagree, say so in the thread
with concrete evidence — what the system actually does, what the API or database
will actually accept. A reviewer given a real rebuttal will dismiss its own
finding, and that exchange is worth more than silently complying with a wrong
one. When a finding asserts a failure mode rather than pointing at visible broken
behavior, measure the real system to settle it rather than arguing in the
abstract.

Verify each fix the same way you verified the original work. Collapsing two
constraints that merely looked alike, or hoisting an invariant into a shared
helper, is exactly how a review fix introduces a regression of its own.

## Autonomous Review

When Autonomous Review is enabled for a session, the loop is driven for you:
commit and push, open a draft PR with `create_pr`, launch the reviewer, then
**end the turn**. Do not poll, sleep, call `list_agents`, or schedule a wakeup —
Dispatch injects the review prompt when it is ready. A clean zero-item approval
needs no action; otherwise work the items above. Don't report the task complete
until every submitted review is resolved.

## Cleaning up

Once a reviewer's output is consumed, `dispatch_archive_agent` retires it. See
the `subagents` skill.
