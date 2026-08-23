---
name: sharing
description: Give the user a file, screenshot, log, or snippet they can actually open. Use whenever you produce an artifact worth seeing — writing it to disk and pasting the path does not surface it in Dispatch.
---

# Sharing artifacts with the user

When you produce something the user should see — a screenshot, a diff, a
generated config, a log excerpt, a report — hand it over with `dispatch_share_file`.
It uploads the artifact into the Dispatch session, where it renders inline and
stays attached to the conversation.

If `dispatch_share_file` is not in your tool list, you are talking to a Dispatch
server from before the rename — the same tool is registered there as
`dispatch_share`, and everything below applies unchanged.

**The failure this prevents:** writing the file to `/tmp` and pasting the path.
That path is meaningless to a user reading the session in a browser, on a phone,
or on a different machine from the one the agent is running on. A local path is
not a deliverable.

## Two ways to call it

**Share a file that already exists:**

```
dispatch_share_file  filePath: "/tmp/login-flow.png",
                     description: "Login flow after the redirect fix"
```

**Share text you are generating right now** — no temp file needed:

```
dispatch_share_file  content: "…",
                     name: "migration-plan.md",
                     description: "Proposed migration order"
```

`name` is required with `content` and must carry a real extension — it drives
syntax highlighting and how the artifact renders.

Supported: images (`png`, `jpg`, `jpeg`, `gif`, `webp`), video (`mp4`), documents
(`pdf`), and text (`txt`, `md`, `json`, `yaml`, `ts`, `py`, `go`, `rs`, `sh`,
`sql`, and similar).

`source: "simulator"` captures directly from a booted iOS Simulator — pass
`simulatorUdid` to target a specific one, or leave it for the booted device.

## Updating instead of duplicating

Every share returns a `fileName`. Pass it back as `update` to replace the
contents in place:

```
dispatch_share_file  filePath: "/tmp/report.md",
                     description: "Report — second pass",
                     update: "<fileName from the first call>"
```

Use this for anything you regenerate — a report that gets refined, a screenshot
retaken after a fix. Five near-identical uploads make the session harder to read,
not more thorough.

## Managing what you've shared

```
dispatch_list_media    — metadata for this agent's shared files, including filePath
dispatch_delete_media  fileName — permanently removes the file and its record
```

`dispatch_list_media` returns metadata only; read the content through `filePath`
with normal file tools.

## Write a description that earns the click

The description is the label the user sees before deciding to open it. Say what
the artifact _shows_, not what it is:

- Weak: "screenshot.png"
- Strong: "Sidebar collapsed — the overflow menu no longer clips at 375px"

## When to share

- **Any screenshot from a browser or simulator run.** Never leave one local-only.
- **Before/after pairs** when you have fixed something visual — two shares beat a
  paragraph describing the difference.
- **Long output** you would otherwise paste into chat: test failures, generated
  files, query results. Shared, it stays readable and does not bury your summary.
- **Anything the user might want to forward.** A path cannot be forwarded.

Keep the prose summary in your reply and put the bulk in the artifact. The reply
says what happened; the share is the evidence.
