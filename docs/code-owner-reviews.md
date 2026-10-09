# Code owner reviews

Code owners are review personas with specific knowledge of a subsystem. They
can own server code, UI, shared contracts, and tests together. Their instructions
live in `.agents/personas/<slug>.md`; routing lives in `.agents/owners.json`.
The older `.dispatch/personas/` and `.dispatch/codeowners.json` locations are
still read; a file under `.agents/` wins over its legacy counterpart.

## Launch

Call `launch_owner_reviews` with `context` explaining the change, decisions,
concerns, and what is out of scope. Optional `agentType` and `model` use the normal
reviewer launch settings. `dryRun: true` returns the selection without starting
agents. This tool is available to parent agents and jobs; child agents ask their
parent to launch reviews.

From the UI, the Review dialog's **Code owners** option (offered when the
checkout has a `.agents/owners.json`) asks the agent to make this call
with its own briefing, alone or alongside hand-picked personas.

Dispatch resolves the normal review base once and selects owners for the union
of committed changes against that base, staged/unstaged changes against HEAD,
and non-ignored untracked files. Deleted paths count; both old and new paths of
renames count. Git errors stop selection rather than imply there are no changes.
The map is read from the current checkout, including uncommitted edits; it does
not borrow configuration or owner definitions from another checkout.

Every matching owner launches once, with the change briefing, its assigned paths,
and the common review base. Reviewers can inspect related code and contracts,
but findings must concern defects caused or worsened by the change. Each reviewer
uses the ordinary ACP persona launch and posts a stream review block to its
launcher. Findings are discussed in their own threads; reviewers verify fixes
and resolve or dismiss them with `update`.
After launching, end the turn. Dispatch delivers submitted reviews automatically.

## Configuration

```json
{
  "version": 1,
  "rules": [
    {
      "paths": ["src/payments/**", "ui/payment*.tsx", "test/payments*"],
      "personas": ["payments-owner"],
      "exclude": ["src/payments/generated/**"]
    },
    { "paths": ["src/payments/storage.ts"], "personas": ["storage-owner"] }
  ],
  "fallback": ["code-review"]
}
```

Patterns match complete repo-relative paths. `*` matches within one segment,
`?` matches one non-slash character, and `**` spans directories. `src/**/x.ts`
also matches `src/x.ts`. There is no implicit basename search, leading slash,
negation, brace expansion, or last-rule-wins behavior. Use rule-local `exclude`
for exclusions; it does not suppress owners from other rules. All matching rules
contribute owners. Overlapping rules and duplicate paths never duplicate a persona.

`fallback` is optional. It receives only paths that matched no explicit rule.
These paths remain in `uncoveredFiles` so ownership gaps stay visible even when a
generalist covers them. Without fallback, uncovered paths launch no reviewer.
An empty change set launches no reviewers. A missing or invalid map is an error.

Before launching, all selected persona slugs must resolve in the current checkout
or built-ins and have instructions. Unknown owners abort the pass before any
reviewers start. `dryRun` reports selection only; it does not validate launch
readiness. Runtime launch failures are returned alongside successful launches;
a successful launch is not a completed review. Retry failed personas individually
with `launch_agent` and its `persona` field rather than duplicating successful launches.

## Dispatch owners

The repository defines owners for agent runtime, review lifecycle, stream delivery,
MCP contracts, stream interactions, jobs/templates/scheduled messages, releases/updates,
authentication/local trust, workspace files, and browser feedback.

`frontend-react-review` is an additional reviewer for `apps/web/src/**` changes.
It checks React correctness, state ownership, accessibility, and rendering behavior
alongside the matching subsystem owners. Each reviewer launches only once even
when several changed paths match. Shared boundary files intentionally select more
than one subsystem owner; unrelated files retain the generalist fallback.

Essential shared frontend rules remain in root `AGENTS.md` and `CLAUDE.md`.
The frontend persona carries its specialized checklist directly in its launch
context. We do not depend on automatic discovery of nested instruction files or
add a new instruction-injection mechanism. Subsystem owners check domain behavior;
the frontend reviewer checks frontend behavior. Findings must demonstrate a defect
or violated repository rule, not a style preference or speculative optimization.

The old role-based repository personas are replaced by these owners. Inherited
personas can still appear in a session's effective list; the ownership map uses
checkout-local definitions and the built-in generalist. Routing regression tests
in `apps/server/test/codeowners-routing.test.ts` pin representative server, UI,
shared-contract, and nested-test paths, including intentional overlap.

When changing a subsystem, update its owner instructions for newly established
invariants and update routing when files move. Keep instructions focused on
checkable behavior and known failures rather than generic engineering advice.
