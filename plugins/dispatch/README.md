# Dispatch plugin

Skills that teach agents how to use Dispatch's own capabilities. Install it in
Claude Code or Codex and agents get shared memory, subagent orchestration, repo
tools, artifact sharing, the review workflow, the whiteboard, jobs, and templates
as discoverable skills instead of tribal knowledge.

## Install

**Claude Code**

```
/plugin marketplace add selfcontained/dispatch
/plugin install dispatch@dispatch
```

Or non-interactively:

```bash
claude plugin marketplace add selfcontained/dispatch
claude plugin install dispatch@dispatch
```

**Codex**

```bash
codex plugin marketplace add selfcontained/dispatch
codex plugin add dispatch@dispatch
```

## Updating

**Claude Code** — `claude plugin update dispatch@dispatch` (or
`/plugin marketplace update dispatch` to refresh the catalog first).

Auto-update is **off by default** for third-party marketplaces like this one.
Turn it on per-marketplace in `/plugin` → Marketplaces if you want updates
picked up in the background.

**Codex** — there is no update subcommand. Re-run
`codex plugin add dispatch@dispatch` to upgrade; it replaces the cached copy.
`codex plugin marketplace upgrade` only refreshes the catalog snapshot, not the
installed plugin, and `codex plugin list` will not tell you a newer version
exists.

The plugin carries an explicit `version` in its manifests, so updates only ship
when that version is bumped — routine commits to `main` do not register as a
plugin update.

## Trust

Plugins on both platforms are **unsigned and unsandboxed, and run with your full
local user privileges**. That is true of this plugin and of every other one you
install from a self-hosted marketplace. This plugin ships skills only — no
hooks, no bundled MCP servers, no executables — but you should verify that for
yourself rather than take this file's word for it: the entire contents are the
`skills/` directory plus two manifests.

## What's in it

| Skill             | Fires when                                                    |
| ----------------- | ------------------------------------------------------------- |
| `brain`           | Something needs to outlive the session or reach another agent |
| `subagents`       | Work should be delegated, or another agent needs coordinating |
| `repo-tools`      | A repo script should become a first-class tool                |
| `sharing`         | An artifact needs to reach the user                           |
| `review-workflow` | A PR is going up, or review feedback needs working            |
| `ui-validation`   | A UI change needs proving in a browser                        |
| `personas`        | This repo needs a reviewer with a domain lens                 |
| `whiteboard`      | The user's sketch matters, or a diagram beats prose           |
| `jobs`            | Work should run on a schedule and report structurally         |
| `templates`       | A launch configuration is worth saving                        |
| `personalities`   | The user is commenting on how agents talk                     |

## Design notes

**The description is the product.** Skill descriptions are loaded into every
session unconditionally — that is the cost the plugin always pays. The body is
loaded only when a skill matches. So descriptions are written as _symptom
triggers_ ("you have produced a file the user should see") rather than feature
labels ("artifact sharing API"): an agent that does not know a capability exists
will never match its name, but will match a description of the situation it is
currently in.

**Narrow skills, not mega-skills.** Eleven narrow skills cost eleven short
descriptions always-on and load exactly one body on a match. Folding them into
three broad skills would load four unrelated bodies every time one of them fired.
The binding budget is total description bytes (currently ~2.3 KB), not skill
count.

**What is deliberately _not_ here.** Guidance that is always relevant cannot be
a skill, because skills only load on a task match. Status reporting
(`dispatch_event`), pin discipline, and session naming stay in Dispatch's
injected launch guidance for that reason.

## Layout

Dual manifests, one tree — both platforms install from the same repo:

```
.claude-plugin/marketplace.json      # Claude Code marketplace
.agents/plugins/marketplace.json     # Codex marketplace
plugins/dispatch/
├── .claude-plugin/plugin.json       # Claude Code manifest
├── .codex-plugin/plugin.json        # Codex manifest
├── skills/<name>/SKILL.md           # shared by both platforms
└── evals/                           # see evals/README.md
```

Codex can also read `.claude-plugin/` as a fallback, but that behavior is
undocumented by OpenAI, so the Codex-native manifests are carried explicitly.
