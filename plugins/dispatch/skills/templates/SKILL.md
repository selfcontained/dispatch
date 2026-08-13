---
name: templates
description: Save a reusable agent launch configuration with fill-in-the-blank arguments, launchable from the command palette. Use when the user keeps starting the same kind of task, or to back a scheduled job.
---

# Templates: reusable agent launches

A template is a saved agent launch — prompt, agent type, directory, worktree
settings — that a human can fire from the Cmd+K command palette or that a job can
run on a schedule.

The signal that you want one: you just wrote a careful multi-paragraph launch
prompt, or the user has asked for the same shape of task a third time. Templates
are also the prerequisite for jobs — see the `jobs` skill.

## Tools

```
list_templates  — scoped to a directory; reports promptArgs and promptChars, not prompt bodies
get_template    — one template by ID, or by name within a directory
create_template — only `name` is required
update_template — pass only the fields you want to change
delete_template — fails if any job references it
```

Templates are unique per (`directory`, `name`). `list_templates` deliberately
omits prompt bodies — call `get_template` for the one you actually want.

## Fields

| Field         | Meaning                                              |
| ------------- | ---------------------------------------------------- |
| `name`        | Display name, unique within `directory`              |
| `description` | Shown in Cmd+K and launch views                      |
| `directory`   | Absolute path of the repo this template runs against |
| `prompt`      | The agent's first turn                               |
| `agentType`   | `claude`, `codex`, `cursor`, or `opencode`           |
| `model`       | Optional model id, matching the agent type           |
| `useWorktree` | Give the agent its own git worktree                  |
| `baseBranch`  | Base branch for that worktree                        |
| `branchName`  | Branch name for that worktree                        |
| `fullAccess`  | Pass the CLI's full-access / bypass-approvals flag   |
| `callable`    | Show it in the Cmd+K command palette                 |

Set `useWorktree` for anything that writes code. Agents sharing a working tree
overwrite each other's changes, and the damage is silent.

## Runtime arguments

Put `{{D:Arg Name}}` placeholders in the prompt and they become fields at launch:

```
Review the PR at {{D:PR URL|required}} and focus on {{D:Review Focus|multiline}}.
```

- Arguments are **optional by default**.
- `|required` makes it mandatory at launch.
- `|multiline` (or `|textarea`) renders a textarea instead of a single-line input.
- Repeated occurrences merge their modifiers — required or multiline anywhere
  applies everywhere.

Argument values are also pinned to the launched agent's sidebar for reference.

**Write prompts that still read correctly with optional arguments blank.** A
blank optional argument has its placeholder removed and the surrounding text left
as-is, so `focus on {{D:Review Focus}}.` becomes a dangling `focus on .` Phrase it
so the sentence survives — or make the argument required.

`dispatch_launch_agent` accepts `templateArgs` for launching a template
programmatically; `get_template`'s `promptArgs` field tells you which argument
names it expects.

## The command palette

Templates with `callable: true` appear in Cmd+K under "Templates":

- **No arguments** → a confirmation step; Enter twice launches it.
- **With arguments** → a launch dialog for filling values in first.

Set `callable: false` for templates that exist only to back a job — otherwise the
palette fills with entries nobody launches by hand.

## Writing the prompt

The launched agent starts with none of your context, so the prompt is its entire
briefing. The guidance in the `subagents` skill applies directly: state the
deliverable, name real paths, say what is out of scope, and record decisions that
should not be relitigated.

One extra consideration specific to templates: they run again months from now.
Avoid anything that goes stale — "the PR we discussed", "the current sprint",
today's date. Anything that varies per run belongs in an argument.
