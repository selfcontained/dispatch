---
name: personas
description: Author repository-specific reviewers in .dispatch/personas/. Use when generic review keeps missing this repo's real risks, or when a reviewer would need domain rules nobody has written down.
---

# Authoring review personas

A persona is a reviewer with a point of view, stored as a markdown file in the
repo. Dispatch ships a built-in generalist (`code-review`) that works anywhere;
a repo-specific persona is what you write when the generalist keeps missing
things only this codebase knows about — a migration invariant, a tenancy
boundary, a wire format two services agree on.

Launching an existing persona is covered by the `review-workflow` skill. This
skill is about creating one.

## When it is worth writing

- The same class of defect keeps reaching main.
- A correct-looking change can still be wrong for reasons that live in the
  domain, not the diff.
- Onboarding docs describe rules that reviewers should be checking mechanically.

If you cannot name the specific failure the persona would catch, you do not need
a persona yet — use `code-review`.

## Tools

```
list_personas     — effective list: repo personas plus the built-in generalist
persona_templates — starting points with the exact authoring fields
persona_upsert    — create or update a persona in .dispatch/personas/
persona_validate  — check personas parse and have required fields
```

Call `list_personas` first. A near-match you can sharpen beats a new file, and
duplicate reviewers with overlapping scope produce duplicate findings.

## Templates

`persona_templates` returns three starting points:

| id              | For                                                              |
| --------------- | ---------------------------------------------------------------- |
| `code-review`   | Correctness and maintainability — a focused engineering reviewer |
| `product-ux`    | User-facing flows, wording, empty/error states, accessibility    |
| `domain-review` | A deliberately blank frame for a repo-specific expert reviewer   |

`domain-review` is the one to start from for anything genuinely repo-specific:
its instructions are a placeholder telling you to replace them with the business
rules, invariants, data boundaries, and failure modes reviewers should check.

## Writing one

```
persona_upsert  slug: "migration-safety",
                template: "domain-review",
                name: "Migration Safety",
                description: "Reviews schema and data migrations for irreversible or blocking operations.",
                instructions: "…",
                feedbackFormat: "findings"
```

- **`slug`** — lowercase letters, numbers, single hyphens, max 80 chars. It is
  the filename and the launch identifier.
- **`description`** — how anyone (human or agent) decides whether to launch this
  reviewer. Name the risk it covers, not the role it plays.
- **`instructions`** — the persona's whole brief. Write the checklist you wish
  someone had handed you: the invariants, what "wrong" looks like concretely,
  which failure modes are cheap to miss.
- **`feedbackFormat`** — single-line, defaults to `findings`.

Writes land in `.dispatch/personas/<slug>.md` inside the current workspace, and
only there — the writer refuses symlinked directories and paths that escape the
workspace. Rendered file:

```markdown
---
name: Migration Safety
description: Reviews schema and data migrations for irreversible or blocking operations.
feedbackFormat: findings
---

<instructions>
```

You can also write the file by hand; `persona_upsert` just gets the frontmatter
right. Run `persona_validate` afterward either way.

## What makes instructions actually work

- **State the invariants, not the vibe.** "Every migration must be reversible or
  explicitly marked irreversible with a rollback note" is checkable. "Be careful
  with migrations" is not.
- **Scope it to the diff.** Say explicitly that only issues introduced or
  worsened by the reviewed change are in scope. Without that line, personas
  report pre-existing debt and bury the real finding.
- **Ask for impact and a fix.** Require each finding to name the concrete failure
  scenario and point at the smallest useful change.
- **Keep each persona narrow.** Two sharp reviewers find more than one broad one,
  and their findings barely overlap.

## Worktree precedence

Personas resolve from the agent's worktree first, then the repo root, then the
built-ins. A persona edited inside a worktree takes effect for that agent
immediately — which is how you iterate on one before committing it.
